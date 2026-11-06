import asyncio
import json
import os
import secrets
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.types import Implementation


async def main():
    url = os.environ['OFFORA_TEST_URL'].rstrip('/') + '/mcp/' + secrets.token_hex(32)
    notifications = asyncio.Queue()

    async def receive(params):
        if params.logger == 'offora.members':
            await notifications.put(params.data)

    async def expect(predicate):
        async with asyncio.timeout(15):
            while True:
                item = await notifications.get()
                if predicate(item):
                    return item

    async with streamablehttp_client(url) as (read, write, _):
        async with ClientSession(read, write, logging_callback=receive, client_info=Implementation(name='sdk-roster-a', version='1')) as a:
            initialized = await a.initialize()
            initial = initialized.model_dump(by_alias=True)['_meta']['office_roster']
            assert len(initial['sessions']) == 1
            a_id = initial['sessions'][0]['session_id']
            result = await a.call_tool('office_describe', {'goal': '維護畫面', 'computer': 'SDK測試機', 'environment': 'Linux'})
            assert not result.isError
            table = json.loads(result.content[0].text)['office_roster']
            assert table['sessions'][0]['goal'] == '維護畫面'
            await expect(lambda item: any(m['goal'] == '維護畫面' for m in item['office_roster']['sessions']))
            async with streamablehttp_client(url) as (read_b, write_b, _):
                async with ClientSession(read_b, write_b, client_info=Implementation(name='sdk-roster-b', version='1')) as b:
                    joined = await b.initialize()
                    table = joined.model_dump(by_alias=True)['_meta']['office_roster']
                    assert any(m['session_id'] == a_id and m['goal'] == '維護畫面' for m in table['sessions'])
                    b_id = next(m['session_id'] for m in table['sessions'] if m['session_id'] != a_id)
                    await expect(lambda item: any(m['session_id'] == b_id for m in item['joined']))
                    result = await b.call_tool('office_describe', {'goal': '維護接口', 'computer': 'SDK測試機', 'environment': 'Linux'})
                    assert not result.isError
                    await expect(lambda item: any(m['session_id'] == b_id and m['goal'] == '維護接口' for m in item['updated']))
            await expect(lambda item: any(m['session_id'] == b_id for m in item['left']))
    print('official MCP SDK: initial roster, two connected clients, join/profile/leave callbacks passed; 0 skipped')


asyncio.run(main())
