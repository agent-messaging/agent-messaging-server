"""The A2A project's Hello World sample, on a2a-sdk 1.1.0, for the gateway's
interop test (__tests__/a2a-sdk-interop.test.ts).

Copied from https://github.com/a2aproject/a2a-samples
(samples/python/agents/helloworld, Apache-2.0) with two changes only: the two
files are one, and the port comes from argv (0 picks a free one, printed as
`PORT <n>` once the server listens). The agent, its card, its request handler
and its routes are the sample's own, so what the gateway meets here is what a
developer who starts from the sample serves.
"""

import asyncio
import socket
import sys

import uvicorn
from a2a.helpers import (
    get_message_text,
    new_task_from_user_message,
    new_text_message,
    new_text_part,
)
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore, TaskUpdater
from a2a.types import (
    AgentCapabilities,
    AgentCard,
    AgentInterface,
    AgentSkill,
    TaskState,
)
from starlette.applications import Starlette


class HelloWorldAgent:
    async def invoke(self, user_request: str) -> str:
        return f'Hello, World! I have received your request ({user_request})'


class HelloWorldAgentExecutor(AgentExecutor):
    def __init__(self) -> None:
        self.agent = HelloWorldAgent()

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        if context.current_task:
            task = context.current_task
        else:
            task = new_task_from_user_message(context.message)
            await event_queue.enqueue_event(task)
        task_updater = TaskUpdater(event_queue=event_queue, task_id=task.id, context_id=task.context_id)
        await task_updater.update_status(
            state=TaskState.TASK_STATE_WORKING,
            message=new_text_message('Processing request...'),
        )
        query = get_message_text(context.message)
        result = await self.agent.invoke(user_request=query) if query else 'No text input is provided!'
        await task_updater.add_artifact(parts=[new_text_part(text=result, media_type='text/plain')])
        await task_updater.update_status(
            state=TaskState.TASK_STATE_COMPLETED,
            message=new_text_message('Request is completed!'),
        )

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        raise NotImplementedError('Cancel is not supported.')


def main() -> None:
    requested = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(('127.0.0.1', requested))
    port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'

    skill = AgentSkill(
        id='echo_bot',
        name='Echo Bot',
        description='An example agent that acknowledges client request and responds with a "Hello World" message.',
        input_modes=['text/plain'],
        output_modes=['text/plain'],
        tags=['a2a', 'echo-example'],
        examples=['hi', 'how are you'],
    )
    public_agent_card = AgentCard(
        name='Hello World Agent',
        description='Just a hello world agent',
        version='0.0.1',
        default_input_modes=['text/plain'],
        default_output_modes=['text/plain'],
        capabilities=AgentCapabilities(streaming=True, extended_agent_card=True),
        supported_interfaces=[AgentInterface(protocol_binding='JSONRPC', url=base, protocol_version='1.0')],
        skills=[skill],
    )
    request_handler = DefaultRequestHandler(
        agent_executor=HelloWorldAgentExecutor(),
        task_store=InMemoryTaskStore(),
        agent_card=public_agent_card,
    )
    routes = []
    routes.extend(create_agent_card_routes(public_agent_card))
    routes.extend(create_jsonrpc_routes(request_handler, '/'))
    app = Starlette(routes=routes)

    server = uvicorn.Server(uvicorn.Config(app, log_level='warning'))

    async def serve() -> None:
        task = asyncio.create_task(server.serve(sockets=[sock]))
        while not server.started:
            await asyncio.sleep(0.05)
        print(f'PORT {port}', flush=True)
        await task

    asyncio.run(serve())


if __name__ == '__main__':
    main()
