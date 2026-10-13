const S = require(require('path').join(__dirname, 'harness.cjs'));
let fail = 0;
function ok(n,c,x){console.log((c?'  PASS  ':'  FAIL  ')+n+(x!==undefined?'  '+x:''));if(!c)fail++;}

const ctx = { bootstrap:{teams:[],elements:[]}, fixtureEase:{}, data:{}, history:{ current:[{event:1,points:50,rank:1,overall_rank:1,points_on_bench:0,event_transfers:0,event_transfers_cost:0,value:1000,bank:0}] } };

// Replay a scripted server so the loop's protocol can be inspected.
function withScript(responses) {
  const sent = [];
  S.callClaudeRaw_ = function (payload) {
    sent.push(JSON.parse(JSON.stringify(payload)));
    const r = responses.shift();
    if (!r) throw new Error('script exhausted after ' + sent.length + ' calls');
    return r;
  };
  return sent;
}

// --- a single tool round -------------------------------------------------
let sent = withScript([
  { stop_reason:'tool_use', content:[
      { type:'thinking', thinking:'REASONING' },
      { type:'text', text:'Let me check.' },
      { type:'tool_use', id:'tu_1', name:'get_my_season', input:{} } ] },
  { stop_reason:'end_turn', content:[{ type:'text', text:'You averaged 50.' }] }
]);
let msgs = [{ role:'user', content:'How has my season gone?' }];
let out = S.runAiTurn_([{type:'text',text:'sys'}], msgs, ctx);

ok('returns the final text', out.text === 'You averaged 50.', JSON.stringify(out.text));
ok('records the tool it used', out.toolsUsed.length === 1 && out.toolsUsed[0].name === 'get_my_season');
ok('made exactly two API calls', sent.length === 2, sent.length);
ok('sends the tool definitions', Array.isArray(sent[0].tools) && sent[0].tools.length === S.AI_TOOLS.length);

const secondMsgs = sent[1].messages;
const assistantTurn = secondMsgs[1];
ok('echoes the assistant content back', assistantTurn.role === 'assistant' && Array.isArray(assistantTurn.content));
ok('preserves thinking blocks verbatim',
   assistantTurn.content.some(b => b.type === 'thinking' && b.thinking === 'REASONING'),
   JSON.stringify(assistantTurn.content.map(b=>b.type)));
const resultTurn = secondMsgs[2];
ok('answers with a user tool_result turn', resultTurn.role === 'user' && resultTurn.content[0].type === 'tool_result');
ok('matches the tool_use_id', resultTurn.content[0].tool_use_id === 'tu_1');
ok('marks a successful result as not an error', resultTurn.content[0].is_error === false);

// --- parallel tool calls in one response ---------------------------------
sent = withScript([
  { stop_reason:'tool_use', content:[
      { type:'tool_use', id:'a', name:'get_my_season', input:{} },
      { type:'tool_use', id:'b', name:'get_league', input:{} } ] },
  { stop_reason:'end_turn', content:[{ type:'text', text:'Done.' }] }
]);
out = S.runAiTurn_([{type:'text',text:'sys'}], [{ role:'user', content:'q' }], ctx);
const parallel = sent[1].messages.filter(m => m.role === 'user' && Array.isArray(m.content))[0];
ok('batches parallel results into ONE user message', parallel.content.length === 2,
   'got ' + parallel.content.length + ' block(s) across ' + sent[1].messages.filter(m=>m.role==='user').length + ' user message(s)');
ok('both tools are recorded', out.toolsUsed.length === 2);

// --- a failing tool does not kill the turn -------------------------------
sent = withScript([
  { stop_reason:'tool_use', content:[{ type:'tool_use', id:'x', name:'does_not_exist', input:{} }] },
  { stop_reason:'end_turn', content:[{ type:'text', text:'I could not look that up, but here is what I know.' }] }
]);
out = S.runAiTurn_([{type:'text',text:'sys'}], [{ role:'user', content:'q' }], ctx);
const errResult = sent[1].messages.filter(m => m.role==='user' && Array.isArray(m.content))[0].content[0];
ok('an unknown tool comes back as an error result, not an exception', errResult.is_error === true);
ok('the turn still produces an answer', out.text.indexOf('here is what I know') !== -1);
ok('a failed tool is recorded as failed', out.toolsUsed[0].ok === false);

// --- the round cap -------------------------------------------------------
// A server that keeps asking for tools while tools are offered, and answers
// once they are withdrawn — which is what a real API does on the forcing call.
sent = [];
let round = 0;
S.callClaudeRaw_ = function (payload) {
  sent.push(JSON.parse(JSON.stringify(payload)));
  if (!payload.tools) return { stop_reason:'end_turn', content:[{ type:'text', text:'Forced answer.' }] };
  return { stop_reason:'tool_use', content:[{ type:'tool_use', id:'r'+(round++), name:'get_my_season', input:{} }] };
};
out = S.runAiTurn_([{type:'text',text:'sys'}], [{ role:'user', content:'q' }], ctx);
ok('stops looping at the round cap', sent.length === S.AI_TOOL_MAX_ROUNDS + 1,
   sent.length + ' calls for a cap of ' + S.AI_TOOL_MAX_ROUNDS);
ok('still returns an answer after the cap', out.text === 'Forced answer.');
ok('the forcing call sends no tools', sent[sent.length-1].tools === undefined);
ok('the forcing call asks for an answer from what it has',
   JSON.stringify(sent[sent.length-1].messages).indexOf('Do not request anything further') !== -1);

// --- text extraction -----------------------------------------------------
ok('joins multiple text blocks',
   S.claudeText_({ content:[{type:'text',text:'a'},{type:'thinking',thinking:'z'},{type:'text',text:'b'}] }) === 'a\nb');
ok('empty content yields an empty string', S.claudeText_({ content:[] }) === '');
ok('missing content does not throw', S.claudeText_({}) === '');

// --- the copy wrapper still returns a plain string ------------------------
withScript([{ stop_reason:'end_turn', content:[{ type:'text', text:'A verdict.' }] }]);
ok('callClaude_ still returns a string for the copy jobs',
   S.callClaude_('sys', [{role:'user',content:'go'}], 200) === 'A verdict.');

console.log(fail?'\n'+fail+' FAILURE(S)':'\nall checks passed');
process.exit(fail?1:0);
