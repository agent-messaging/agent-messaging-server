"""A stock A2A 1.0 client (a2a-sdk 1.1.0) calling the gateway's inbound side,
for the gateway's interop test (__tests__/a2a-sdk-interop.test.ts).

    python -I client_check.py <agent base URL> <gateway key>

The agent base URL is the gateway's `/agents/<id>`; the client reads the card
the gateway generates there, as any 1.0 client would, and calls the JSON-RPC
interface the card names. Every step prints one JSON line:
`{"step": ..., "ok": true, "result": ...}` with the parsed answer, or
`{"step": ..., "ok": false, "error": ...}` when the client refused it. The
client parses every answer strictly against a2a.proto, so a field 1.0 does not
have, or a state in the wrong spelling, is an `ok: false` here.
"""

import asyncio
import json
import sys

import httpx
from a2a.client import ClientConfig, create_client
from a2a.helpers import new_text_message
from a2a.types import GetTaskRequest, SendMessageRequest
from google.protobuf.json_format import MessageToDict


def emit(step: str, ok: bool, value: object) -> None:
    print(json.dumps({'step': step, 'ok': ok, ('result' if ok else 'error'): value}), flush=True)


async def run_step(step: str, coro) -> object | None:
    try:
        value = await coro
    except Exception as err:  # noqa: BLE001 - the test reads the refusal
        emit(step, False, f'{type(err).__name__}: {err}')
        return None
    emit(step, True, value)
    return value


async def collect(client, text: str) -> list[dict]:
    request = SendMessageRequest(message=new_text_message(text))
    return [MessageToDict(event) async for event in client.send_message(request)]


async def main() -> None:
    base, key = sys.argv[1], sys.argv[2]
    headers = {'Authorization': f'Bearer {key}'}
    async with httpx.AsyncClient(headers=headers, timeout=20) as http:
        # The card names both bindings; each is run, JSON-RPC's steps bare
        # and HTTP+JSON's prefixed `rest_`.
        for binding, prefix in (('JSONRPC', ''), ('HTTP+JSON', 'rest_')):
            unary = await create_client(
                base,
                client_config=ClientConfig(streaming=False, httpx_client=http, supported_protocol_bindings=[binding]),
                resolver_http_kwargs={'headers': headers},
            )
            streaming = await create_client(
                base,
                client_config=ClientConfig(streaming=True, httpx_client=http, supported_protocol_bindings=[binding]),
                resolver_http_kwargs={'headers': headers},
            )

            await run_step(f'{prefix}message', collect(unary, 'message'))
            await run_step(f'{prefix}file', collect(unary, 'file'))
            events = await run_step(f'{prefix}task', collect(unary, 'task'))
            task_id = None
            if events:
                task_id = events[0].get('task', {}).get('id')
            if task_id:
                await run_step(f'{prefix}get_task', _get(unary, task_id))
            await run_step(f'{prefix}stream', collect(streaming, 'stream'))


async def _get(client, task_id: str) -> dict:
    return MessageToDict(await client.get_task(GetTaskRequest(id=task_id)))


if __name__ == '__main__':
    asyncio.run(main())
