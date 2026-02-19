sometimes I see the usage for the thread go up significantly after a server-side web search tool request / response. However, afterwards when the thread continues, the usage drops back down.

in node/chat/thread.ts:1202, is the calculation I'm using to see the total number of tokens.

Is this expected behavior, or am I dropping something after the search request / missing the cache somehow?

More detailed debugging:

all code editing functionality\"}],\"chimeVolume\":0}","timestamp":"2026-02-19T03:32:17.718Z"}
{"level":"info","message":"[web-search-debug] continueConversation: sending 1 messages","timestamp":"2026-02-19T03:32:28.721Z"}
{"level":"info","message":"[web-search-debug] message[0] role=user blocks=[text, text, text]","timestamp":"2026-02-19T03:32:28.721Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=0 type=thinking","timestamp":"2026-02-19T03:32:31.090Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=1 type=server_tool_use","timestamp":"2026-02-19T03:32:31.297Z"}
{"level":"info","message":"[web-search-debug] block-finished: type=server_tool_use keys=[type, id, name, input] ","timestamp":"2026-02-19T03:32:31.297Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=2 type=web_search_tool_result","timestamp":"2026-02-19T03:32:34.224Z"}
{"level":"info","message":"[web-search-debug] block-finished: type=web_search_tool_result keys=[type, tool_use_id, content] content.length=10, content_types=[web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result], encrypted_content: 10/10 items have it, total_chars=30736","timestamp":"2026-02-19T03:32:34.224Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=3 type=server_tool_use","timestamp":"2026-02-19T03:32:34.829Z"}
{"level":"info","message":"[web-search-debug] block-finished: type=server_tool_use keys=[type, id, name, input] ","timestamp":"2026-02-19T03:32:34.830Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=4 type=web_search_tool_result","timestamp":"2026-02-19T03:32:36.698Z"}
{"level":"info","message":"[web-search-debug] block-finished: type=web_search_tool_result keys=[type, tool_use_id, content] content.length=0, content_types=[], encrypted_content: 0/0 items have it, total_chars=0","timestamp":"2026-02-19T03:32:36.698Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=5 type=server_tool_use","timestamp":"2026-02-19T03:32:36.995Z"}
{"level":"info","message":"[web-search-debug] block-finished: type=server_tool_use keys=[type, id, name, input] ","timestamp":"2026-02-19T03:32:36.995Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=6 type=web_search_tool_result","timestamp":"2026-02-19T03:32:39.468Z"}
{"level":"info","message":"[web-search-debug] block-finished: type=web_search_tool_result keys=[type, tool_use_id, content] content.length=2, content_types=[web_search_result, web_search_result], encrypted_content: 2/2 items have it, total_chars=1228","timestamp":"2026-02-19T03:32:39.469Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=7 type=server_tool_use","timestamp":"2026-02-19T03:32:39.939Z"}
{"level":"info","message":"[web-search-debug] block-finished: type=server_tool_use keys=[type, id, name, input] ","timestamp":"2026-02-19T03:32:39.939Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=8 type=web_search_tool_result","timestamp":"2026-02-19T03:32:42.349Z"}
{"level":"info","message":"[web-search-debug] block-finished: type=web_search_tool_result keys=[type, tool_use_id, content] content.length=10, content_types=[web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result], encrypted_content: 10/10 items have it, total_chars=31108","timestamp":"2026-02-19T03:32:42.349Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=9 type=text","timestamp":"2026-02-19T03:32:42.827Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=10 type=text","timestamp":"2026-02-19T03:32:44.773Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=11 type=text","timestamp":"2026-02-19T03:32:44.847Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=12 type=text","timestamp":"2026-02-19T03:32:45.608Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=13 type=text","timestamp":"2026-02-19T03:32:46.358Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=14 type=text","timestamp":"2026-02-19T03:32:47.477Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=15 type=text","timestamp":"2026-02-19T03:32:47.724Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=16 type=text","timestamp":"2026-02-19T03:32:49.621Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=17 type=text","timestamp":"2026-02-19T03:32:49.946Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=18 type=text","timestamp":"2026-02-19T03:32:51.002Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=19 type=text","timestamp":"2026-02-19T03:32:51.224Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=20 type=text","timestamp":"2026-02-19T03:32:51.616Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=21 type=text","timestamp":"2026-02-19T03:32:52.121Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=22 type=text","timestamp":"2026-02-19T03:32:54.167Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=23 type=text","timestamp":"2026-02-19T03:32:55.076Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=24 type=text","timestamp":"2026-02-19T03:32:56.501Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=25 type=text","timestamp":"2026-02-19T03:32:56.690Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=26 type=text","timestamp":"2026-02-19T03:32:56.971Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=27 type=text","timestamp":"2026-02-19T03:32:58.543Z"}
{"level":"info","message":"[web-search-debug] stream-completed: finalMessage block types: [thinking, server_tool_use, web_search_tool_result, server_tool_use, web_search_tool_result, server_tool_use, web_search_tool_result, server_tool_use, web_search_tool_result, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text]","timestamp":"2026-02-19T03:32:58.597Z"}
{"level":"info","message":"[web-search-debug] stream-completed/finalMessage: type=server_tool_use keys=[type, id, name, input, caller] ","timestamp":"2026-02-19T03:32:58.598Z"}
{"level":"info","message":"[web-search-debug] stream-completed/finalMessage: type=web_search_tool_result keys=[type, tool_use_id, content, caller] content.length=10, content_types=[web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result], encrypted_content: 10/10 items have it, total_chars=30736","timestamp":"2026-02-19T03:32:58.598Z"}
{"level":"info","message":"[web-search-debug] stream-completed/finalMessage: type=server_tool_use keys=[type, id, name, input, caller] ","timestamp":"2026-02-19T03:32:58.598Z"}
{"level":"info","message":"[web-search-debug] stream-completed/finalMessage: type=web_search_tool_result keys=[type, tool_use_id, content, caller] content.length=0, content_types=[], encrypted_content: 0/0 items have it, total_chars=0","timestamp":"2026-02-19T03:32:58.598Z"}
{"level":"info","message":"[web-search-debug] stream-completed/finalMessage: type=server_tool_use keys=[type, id, name, input, caller] ","timestamp":"2026-02-19T03:32:58.598Z"}
{"level":"info","message":"[web-search-debug] stream-completed/finalMessage: type=web_search_tool_result keys=[type, tool_use_id, content, caller] content.length=2, content_types=[web_search_result, web_search_result], encrypted_content: 2/2 items have it, total_chars=1228","timestamp":"2026-02-19T03:32:58.598Z"}
{"level":"info","message":"[web-search-debug] stream-completed/finalMessage: type=server_tool_use keys=[type, id, name, input, caller] ","timestamp":"2026-02-19T03:32:58.598Z"}
{"level":"info","message":"[web-search-debug] stream-completed/finalMessage: type=web_search_tool_result keys=[type, tool_use_id, content, caller] content.length=10, content_types=[web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result], encrypted_content: 10/10 items have it, total_chars=31108","timestamp":"2026-02-19T03:32:58.598Z"}
{"level":"info","message":"[web-search-debug] stream-completed/stored: type=server_tool_use keys=[type, id, name, input, caller] ","timestamp":"2026-02-19T03:32:58.598Z"}
{"level":"info","message":"[web-search-debug] stream-completed/stored: type=web_search_tool_result keys=[type, tool_use_id, content, caller] content.length=10, content_types=[web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result], encrypted_content: 10/10 items have it, total_chars=30736","timestamp":"2026-02-19T03:32:58.598Z"}
{"level":"info","message":"[web-search-debug] stream-completed/stored: type=server_tool_use keys=[type, id, name, input, caller] ","timestamp":"2026-02-19T03:32:58.598Z"}
{"level":"info","message":"[web-search-debug] stream-completed/stored: type=web_search_tool_result keys=[type, tool_use_id, content, caller] content.length=0, content_types=[], encrypted_content: 0/0 items have it, total_chars=0","timestamp":"2026-02-19T03:32:58.598Z"}
{"level":"info","message":"[web-search-debug] stream-completed/stored: type=server_tool_use keys=[type, id, name, input, caller] ","timestamp":"2026-02-19T03:32:58.598Z"}
{"level":"info","message":"[web-search-debug] stream-completed/stored: type=web_search_tool_result keys=[type, tool_use_id, content, caller] content.length=2, content_types=[web_search_result, web_search_result], encrypted_content: 2/2 items have it, total_chars=1228","timestamp":"2026-02-19T03:32:58.598Z"}
{"level":"info","message":"[web-search-debug] stream-completed/stored: type=server_tool_use keys=[type, id, name, input, caller] ","timestamp":"2026-02-19T03:32:58.598Z"}
{"level":"info","message":"[web-search-debug] stream-completed/stored: type=web_search_tool_result keys=[type, tool_use_id, content, caller] content.length=10, content_types=[web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result], encrypted_content: 10/10 items have it, total_chars=31108","timestamp":"2026-02-19T03:32:58.598Z"}
{"level":"info","message":"[web-search-debug] stream-completed: stored assistant message block types: [thinking, server_tool_use, web_search_tool_result, server_tool_use, web_search_tool_result, server_tool_use, web_search_tool_result, server_tool_use, web_search_tool_result, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text]","timestamp":"2026-02-19T03:32:58.598Z"}
{"level":"info","message":"Usage: inputTokens=14 outputTokens=914 cacheHits=78390 cacheMisses=31745 stopReason=end_turn","timestamp":"2026-02-19T03:32:58.599Z"}
{"level":"info","message":"[web-search-debug] continueConversation: sending 3 messages","timestamp":"2026-02-19T03:33:06.067Z"}
{"level":"info","message":"[web-search-debug] message[0] role=user blocks=[text, text, text]","timestamp":"2026-02-19T03:33:06.067Z"}
{"level":"info","message":"[web-search-debug] message[1] role=assistant blocks=[thinking, server_tool_use, web_search_tool_result, server_tool_use, web_search_tool_result, server_tool_use, web_search_tool_result, server_tool_use, web_search_tool_result, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, text]","timestamp":"2026-02-19T03:33:06.067Z"}
{"level":"info","message":"[web-search-debug] continueConversation/message[1]: type=server_tool_use keys=[type, id, name, input, caller] ","timestamp":"2026-02-19T03:33:06.067Z"}
{"level":"info","message":"[web-search-debug] continueConversation/message[1]: type=web_search_tool_result keys=[type, tool_use_id, content, caller] content.length=10, content_types=[web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result], encrypted_content: 10/10 items have it, total_chars=30736","timestamp":"2026-02-19T03:33:06.067Z"}
{"level":"info","message":"[web-search-debug] continueConversation/message[1]: type=server_tool_use keys=[type, id, name, input, caller] ","timestamp":"2026-02-19T03:33:06.067Z"}
{"level":"info","message":"[web-search-debug] continueConversation/message[1]: type=web_search_tool_result keys=[type, tool_use_id, content, caller] content.length=0, content_types=[], encrypted_content: 0/0 items have it, total_chars=0","timestamp":"2026-02-19T03:33:06.067Z"}
{"level":"info","message":"[web-search-debug] continueConversation/message[1]: type=server_tool_use keys=[type, id, name, input, caller] ","timestamp":"2026-02-19T03:33:06.067Z"}
{"level":"info","message":"[web-search-debug] continueConversation/message[1]: type=web_search_tool_result keys=[type, tool_use_id, content, caller] content.length=2, content_types=[web_search_result, web_search_result], encrypted_content: 2/2 items have it, total_chars=1228","timestamp":"2026-02-19T03:33:06.067Z"}
{"level":"info","message":"[web-search-debug] continueConversation/message[1]: type=server_tool_use keys=[type, id, name, input, caller] ","timestamp":"2026-02-19T03:33:06.067Z"}
{"level":"info","message":"[web-search-debug] continueConversation/message[1]: type=web_search_tool_result keys=[type, tool_use_id, content, caller] content.length=10, content_types=[web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result, web_search_result], encrypted_content: 10/10 items have it, total_chars=31108","timestamp":"2026-02-19T03:33:06.067Z"}
{"level":"info","message":"[web-search-debug] message[2] role=user blocks=[text, text]","timestamp":"2026-02-19T03:33:06.067Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=0 type=thinking","timestamp":"2026-02-19T03:33:09.483Z"}
{"level":"info","message":"[web-search-debug] block-finished: index=1 type=text","timestamp":"2026-02-19T03:33:09.634Z"}
{"level":"info","message":"[web-search-debug] stream-completed: finalMessage block types: [thinking, text]","timestamp":"2026-02-19T03:33:09.780Z"}
{"level":"info","message":"[web-search-debug] stream-completed: stored assistant message block types: [thinking, text]","timestamp":"2026-02-19T03:33:09.780Z"}
{"level":"info","message":"Usage: inputTokens=10 outputTokens=31 cacheHits=31745 cacheMisses=1143 stopReason=end_turn","timestamp":"2026-02-19T03:33:09.780Z"}
