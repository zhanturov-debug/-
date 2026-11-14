#!/usr/bin/env python3
"""MCP-сервер (stdio), через который Claude обращается к Gemini.

Без внешних зависимостей: только стандартная библиотека Python.
Ключ: в облачной сессии Claude Code его подставляет сетевой прокси
(секрет окружения для generativelanguage.googleapis.com). На своём
компьютере задайте переменную окружения GEMINI_API_KEY.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = "https://generativelanguage.googleapis.com/v1beta/openai"
DEFAULT_MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")
FALLBACK_MODEL = os.environ.get("GEMINI_FALLBACK_MODEL", "gemini-flash-lite-latest")
# Весь вызов инструмента, с повторами: клиент обрывает его через 60 секунд.
BUDGET = float(os.environ.get("GEMINI_BUDGET_SECONDS", "55"))
PROTOCOL = "2025-06-18"
OVERLOADED = (500, 502, 503, 504)


class GeminiError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code

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
                "model": {
                    "type": "string",
                    "description": (
                        "Модель, по умолчанию %s (при перегрузке — %s). "
                        "Имена — из list_gemini_models; pro-модели требуют "
                        "платного тарифа." % (DEFAULT_MODEL, FALLBACK_MODEL)
                    ),
                },
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "list_gemini_models",
        "description": "Список моделей Gemini, доступных по этому ключу.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def http(path, payload=None, timeout=BUDGET):
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
        body = e.read().decode(errors="replace")[:1500]
        raise GeminiError(e.code, "Gemini API вернул HTTP %s: %s" % (e.code, body))
    except OSError as e:  # нет связи или истекло время ожидания
        raise GeminiError(None, "Gemini API не ответил: %s" % (getattr(e, "reason", None) or e))


def ask_gemini(args):
    prompt = args.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise RuntimeError("Параметр prompt обязателен.")
    messages = []
    if args.get("system"):
        messages.append({"role": "system", "content": args["system"]})
    messages.append({"role": "user", "content": prompt})
    # Явно заданную модель не подменяем; запасная — только для модели по умолчанию.
    models = [args["model"]] if args.get("model") else [DEFAULT_MODEL, FALLBACK_MODEL]
    last = GeminiError(None, "Gemini не успел ответить за %d с." % BUDGET)
    deadline = time.monotonic() + BUDGET
    for model in dict.fromkeys(m.removeprefix("models/") for m in models):
        for pause in (0, 3):
            left = deadline - time.monotonic() - pause
            if left < 2:
                raise last
            time.sleep(pause)
            try:
                data = http(
                    "/chat/completions", {"model": model, "messages": messages}, left
                )
            except GeminiError as e:
                last = e
                if e.code in OVERLOADED:
                    continue  # перегрузка: повтор, затем следующая модель
                raise
            choice = (data.get("choices") or [{}])[0]
            text = (choice.get("message") or {}).get("content")
            if not text:
                raise RuntimeError(
                    "Gemini не вернул текст (finish_reason=%s)."
                    % choice.get("finish_reason")
                )
            return "[ответила модель: %s]\n%s" % (model, text)
    raise last


def list_gemini_models(_args):
    data = http("/models")
    ids = [m.get("id", "").removeprefix("models/") for m in data.get("data", [])]
    return "\n".join(i for i in ids if i)


HANDLERS = {"ask_gemini": ask_gemini, "list_gemini_models": list_gemini_models}


def handle(msg):
    method = msg.get("method")
    params = msg.get("params") or {}
    if method == "initialize":
        return {
            "protocolVersion": params.get("protocolVersion") or PROTOCOL,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "gemini", "version": "1.0.0"},
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
