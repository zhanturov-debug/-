#!/usr/bin/env python3
"""MCP-сервер (stdio), через который Claude обращается к Gemini.

Без внешних зависимостей: только стандартная библиотека Python.
Ключ: в облачной сессии Claude Code его подставляет сетевой прокси
(секрет окружения для generativelanguage.googleapis.com). На своём
компьютере задайте переменную окружения GEMINI_API_KEY.
"""
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile

BASE = "https://generativelanguage.googleapis.com/v1beta/openai"
DEFAULT_MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-lite-latest")
FALLBACK_MODEL = os.environ.get("GEMINI_FALLBACK_MODEL", "gemini-3.5-flash")
# Весь вызов инструмента: клиент обрывает его через 60 секунд.
BUDGET = float(os.environ.get("GEMINI_BUDGET_SECONDS", "55"))
# Один запрос: прокси облачной сессии обрывает его на 30-й секунде.
ATTEMPT = float(os.environ.get("GEMINI_ATTEMPT_SECONDS", "28"))
PROTOCOL = "2025-06-18"
# Сбой или молчание модели (None — нет ответа): пробуем следующую модель.
NEXT_MODEL = (None, 500, 502, 503, 504)

MODEL_PARAM = {
    "type": "string",
    "description": (
        "Модель, по умолчанию %s (при сбое — %s). Имена — из "
        "list_gemini_models. Запрос дольше %d с обрывается, поэтому медленные "
        "модели годятся только для коротких задач; pro-модели на бесплатном "
        "тарифе недоступны." % (DEFAULT_MODEL, FALLBACK_MODEL, ATTEMPT)
    ),
}

TOOLS = [
    {
        "name": "ask_gemini",
        "description": (
            "Отправить запрос модели Google Gemini и получить её ответ текстом. "
            "Gemini не видит переписку и файлы: всё нужное передавайте в prompt."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "Текст запроса."},
                "system": {
                    "type": "string",
                    "description": "Необязательная системная инструкция.",
                },
                "model": MODEL_PARAM,
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "ask_gemini_about_files",
        "description": (
            "Отдать Gemini файлы с диска вместе с вопросом и получить короткий "
            "ответ. Содержимое файлов уходит в Gemini напрямую и в контекст "
            "Claude не попадает — для поиска по большим документам, выжимки, "
            "выписки однотипных данных. Форматы: текстовые файлы, .docx, .pdf "
            "с текстовым слоем. На бесплатном тарифе проходит около 100 страниц "
            "за запрос."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "Что найти или сделать с содержимым файлов.",
                },
                "paths": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Пути к файлам на диске.",
                },
                "model": MODEL_PARAM,
            },
            "required": ["question", "paths"],
        },
    },
    {
        "name": "list_gemini_models",
        "description": "Список моделей Gemini, доступных по этому ключу.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


class GeminiError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def http(path, payload=None, timeout=ATTEMPT):
    key = os.environ.get("GEMINI_API_KEY") or "proxy-injected"
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
        },
        method="POST" if payload is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:600]
        hint = ""
        if e.code == 429:
            hint = (
                " Подсказка: исчерпана квота тарифа либо запрос слишком велик "
                "для него — уменьшите объём или смените модель."
            )
        raise GeminiError(e.code, "Gemini API вернул HTTP %s: %s%s" % (e.code, body, hint))
    except OSError as e:  # нет связи или истекло время ожидания
        raise GeminiError(
            None,
            "Gemini не ответил за %d с (%s)." % (timeout, getattr(e, "reason", None) or e),
        )


def complete(messages, model):
    """Ответ первой модели, которая справилась; явно заданную не подменяем."""
    models = [model] if model else [DEFAULT_MODEL, FALLBACK_MODEL]
    last = GeminiError(None, "Gemini не успел ответить за %d с." % BUDGET)
    deadline = time.monotonic() + BUDGET
    for name in dict.fromkeys(m.removeprefix("models/") for m in models):
        left = deadline - time.monotonic()
        if left < 2:
            break
        try:
            data = http(
                "/chat/completions",
                {"model": name, "messages": messages},
                min(left, ATTEMPT),
            )
        except GeminiError as e:
            last = e
            if e.code in NEXT_MODEL:
                continue
            raise
        choice = (data.get("choices") or [{}])[0]
        text = (choice.get("message") or {}).get("content")
        if not text:
            raise RuntimeError(
                "Gemini не вернул текст (finish_reason=%s)." % choice.get("finish_reason")
            )
        return "[ответила модель: %s]\n%s" % (name, text)
    raise last


def ask_gemini(args):
    prompt = args.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise RuntimeError("Параметр prompt обязателен.")
    messages = []
    if args.get("system"):
        messages.append({"role": "system", "content": args["system"]})
    messages.append({"role": "user", "content": prompt})
    return complete(messages, args.get("model"))


def read_text(path):
    """Текст файла: .docx и .pdf извлекаются, остальное читается как текст."""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".docx":
        with zipfile.ZipFile(path) as z:
            xml = z.read("word/document.xml").decode("utf-8", errors="replace")
        xml = re.sub(r"</w:p>|<w:br[^>]*/>", "\n", xml).replace("</w:tc>", "\t")
        return html.unescape(re.sub(r"<[^>]+>", "", xml))
    if ext == ".pdf":
        if not shutil.which("pdftotext"):
            raise RuntimeError("Для PDF нужна программа pdftotext (пакет poppler-utils).")
        out = subprocess.run(
            ["pdftotext", "-layout", path, "-"], capture_output=True, timeout=40
        )
        if out.returncode != 0:
            raise RuntimeError("pdftotext не прочитал %s." % path)
        text = out.stdout.decode("utf-8", errors="replace")
        if not text.strip():
            raise RuntimeError(
                "В %s нет текстового слоя (скан): такой файл не передаётся." % path
            )
        return text
    with open(path, "rb") as f:
        raw = f.read()
    if b"\0" in raw[:4096]:
        raise RuntimeError("%s — не текстовый файл; формат не поддерживается." % path)
    return raw.decode("utf-8", errors="replace")


def ask_gemini_about_files(args):
    question = args.get("question")
    paths = args.get("paths")
    if not isinstance(question, str) or not question.strip():
        raise RuntimeError("Параметр question обязателен.")
    if not isinstance(paths, list) or not paths:
        raise RuntimeError("Параметр paths обязателен: список путей к файлам.")
    parts, total = [], 0
    for path in paths:
        try:
            text = read_text(os.path.expanduser(str(path)))
        except OSError as e:
            raise RuntimeError("Не удалось прочитать %s: %s" % (path, e))
        total += len(text)
        parts.append("=== Файл: %s ===\n%s" % (os.path.basename(str(path)), text))
    prompt = (
        "%s\n\nОтвечай только по содержимому файлов ниже. Если ответа в них "
        "нет, так и скажи.\n\n%s" % (question, "\n\n".join(parts))
    )
    answer = complete([{"role": "user", "content": prompt}], args.get("model"))
    return "%s\n\n[передано файлов: %d, знаков: %d]" % (answer, len(parts), total)


def list_gemini_models(_args):
    data = http("/models")
    ids = [m.get("id", "").removeprefix("models/") for m in data.get("data", [])]
    return "\n".join(i for i in ids if i)


HANDLERS = {
    "ask_gemini": ask_gemini,
    "ask_gemini_about_files": ask_gemini_about_files,
    "list_gemini_models": list_gemini_models,
}


def handle(msg):
    method = msg.get("method")
    params = msg.get("params") or {}
    if method == "initialize":
        return {
            "protocolVersion": params.get("protocolVersion") or PROTOCOL,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "gemini", "version": "1.1.0"},
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        fn = HANDLERS.get(params.get("name"))
        if fn is None:
            raise LookupError("Неизвестный инструмент: %s" % params.get("name"))
        try:
            text, failed = fn(params.get("arguments") or {}), False
        except Exception as e:  # ошибка вызова возвращается модели, сервер живёт
            text, failed = str(e), True
        return {"content": [{"type": "text", "text": text}], "isError": failed}
    raise LookupError("Метод не поддерживается: %s" % method)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if not isinstance(msg, dict) or "id" not in msg:
            continue  # уведомления ответа не требуют
        reply = {"jsonrpc": "2.0", "id": msg["id"]}
        try:
            reply["result"] = handle(msg)
        except LookupError as e:
            reply["error"] = {"code": -32601, "message": str(e)}
        except Exception as e:
            reply["error"] = {"code": -32603, "message": str(e)}
        sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
