const S = require(require('path').join(__dirname, 'harness.cjs'));
let fail = 0;
function ok(n,c,x){console.log((c?'  PASS  ':'  FAIL  ')+n+(x!==undefined?'  '+x:''));if(!c)fail++;}
function has(s,t){return String(s).indexOf(t)!==-1;}

// --- a small world -------------------------------------------------------
const teams = [{id:1,name:'Bournemouth',short_name:'BOU'},{id:2,name:'Arsenal',short_name:'ARS'},{id:3,name:'Leeds',short_name:'LEE'}];
function el(id,name,type,team,cost,extra){
  return Object.assign({ id, web_name:name, first_name:'', second_name:name, element_type:type, team,
    now_cost:cost, status:'a', news:'', form:'5.0', points_per_game:'4.5', total_points:60, minutes:900,
    ep_next:'5.0', ict_index:'80', selected_by_percent:'20.0', starts:10, starts_per_90:'1.0',
    expected_goal_involvements_per_90:'0.55', transfers_in_event:0, transfers_out_event:0, cost_change_event:0 }, extra||{});
}
const elements = [
  el(1,'Semenyo',3,1,75),
  el(2,'Saka',3,2,100,{ first_name:'Bukayo', second_name:'Saka' }),
  el(3,'Stach',3,3,50,{ status:'i', news:'Knee injury - 50% chance', minutes:200 }),
  el(4,'B.Fernandes',3,2,90,{ first_name:'Bruno', second_name:'Fernandes' }),
  el(5,'Raya',1,2,55),
  el(6,'Timber',2,2,60)
];
const bootstrap = { teams, elements, events:[], total_players:1000000 };
S.SEASON_CONTEXT_ = { finishedGws: 10, avgEntryScore: 50 };
const fixtureEase = {};
[1,2,3].forEach(t => fixtureEase[t] = { name:'T'+t, shortName:'T'+t, eventIds:[11,12,13],
  nextOpponents:['ARS (2)','@LEE (4)'], doubleGw:{}, blankGws:[], fixturesByEvent:{}, avgDifficulty:3, weightedDifficulty:3 });

const ctx = {
  bootstrap, fixtureEase,
  data: {
    entryName: 'Test XI',
    squad: { players: [{ id:1, name:'Semenyo' }] },
    miniLeague: { leagueName:'The Office', rows:[{rank:1,name:'Ann',entryName:'Ann FC',total:600,isYou:false},{rank:2,name:'You',entryName:'Test XI',total:590,isYou:true}] },
    leagueEo: { managersCounted:11, eventId:10, summary:'You are behind the field.',
      threats:[{name:'Saka',team:'ARS',eo:82,owned:73,captained:36,xpNext:6.1,delta:-5.0}],
      edges:[{name:'Semenyo',team:'BOU',eo:12,mine:2,delta:4.2}] }
  },
  history: { current: [
    { event:9, points:54, rank:900000, overall_rank:410000, points_on_bench:6, event_transfers:1, event_transfers_cost:0, value:1005, bank:5 },
    { event:10, points:71, rank:120000, overall_rank:330000, points_on_bench:2, event_transfers:2, event_transfers_cost:4, value:1010, bank:2 }
  ], chips:[{name:'wildcard',event:8}], past:[{season_name:'2024/25',total_points:2200,rank:150000}] }
};

// --- name resolution -----------------------------------------------------
const R = (n) => { const e = S.aiResolvePlayer_(bootstrap, n, fixtureEase); return e && e.web_name; };
ok('resolves an exact web_name', R('Semenyo') === 'Semenyo');
ok('is case insensitive', R('semenyo') === 'Semenyo');
ok('resolves by prefix', R('Sem') === 'Semenyo');
ok('resolves by first name', R('Bukayo') === 'Saka', R('Bukayo'));
ok('resolves by surname not in the web_name', R('Fernandes') === 'B.Fernandes', R('Fernandes'));
ok('returns null for nonsense', R('Zzzzzz') === null);
ok('returns null for empty input', R('') === null);

// --- tools that need no network -----------------------------------------
const season = S.aiToolMySeason_({}, ctx);
ok('/season lists every gameweek', has(season,'GW9') && has(season,'GW10'));
ok('/season totals bench points', has(season,'8 points left on the bench'), season.split('\n').slice(-3).join(' | '));
ok('/season totals hits', has(season,'4 points paid in hits'));
ok('/season names chips played', has(season,'wildcard in GW8'));
ok('/season includes previous seasons', has(season,'2024/25'));

const cmp = S.aiToolComparePlayers_({ players:['Semenyo','Saka'] }, ctx);
ok('compare covers both players', has(cmp,'Semenyo') && has(cmp,'Saka'));
ok('compare marks squad membership', has(cmp,'IN THE MANAGER'));
ok('compare reports fixtures', has(cmp,'next fixtures'));
ok('compare names what it could not find', has(S.aiToolComparePlayers_({players:['Semenyo','Nobody']},ctx),'Could not find: Nobody'));
ok('compare rejects a single name', has(S.aiToolComparePlayers_({players:['Semenyo']},ctx),'at least two'));

const search = S.aiToolSearchPlayers_({ position:'MID', max_price:8.0 }, ctx);
ok('search filters by position and price', has(search,'Semenyo') && !has(search,'Raya'), search.replace(/\n/g,' | '));
ok('search excludes flagged players by default', !has(search,'Stach'));
ok('search can include flagged players', has(S.aiToolSearchPlayers_({position:'MID',available_only:false,max_price:8.0},ctx),'Stach'));
ok('search reports an empty result honestly', has(S.aiToolSearchPlayers_({position:'FWD'},ctx),'No player matches'));

const league = S.aiToolLeague_({}, ctx);
ok('league shows standings and marks the manager', has(league,'The Office') && has(league,'THE MANAGER'));
ok('league reports EO with captaincy', has(league,'captained by 36%'));
ok('league reports the manager edge', has(league,'captain'));

// --- error containment ---------------------------------------------------
const bad = S.runAiTool_('get_player_history', { player:'Semenyo' }, ctx); // network is disabled in the harness
ok('a failing tool returns a readable result rather than throwing', bad.isError === true && has(bad.text,'lookup failed'), bad.text);
ok('an unknown tool is reported, not thrown', S.runAiTool_('nope',{},ctx).isError === true);

// --- tool schema sanity --------------------------------------------------
ok('every tool has a handler', S.AI_TOOLS.every(t => typeof S.AI_TOOL_HANDLERS[t.name] === 'function'),
   S.AI_TOOLS.map(t=>t.name).join(', '));
ok('every tool has a schema and a description',
   S.AI_TOOLS.every(t => t.description && t.description.length > 40 && t.input_schema && t.input_schema.type === 'object'));
ok('required fields exist in properties',
   S.AI_TOOLS.every(t => (t.input_schema.required||[]).every(r => t.input_schema.properties[r])));

// --- transcript persistence ---------------------------------------------
S.writeChatHistory_([{role:'user',content:'hi'},{role:'assistant',content:'hello'}]);
ok('round-trips a transcript', S.readChatHistory_().length === 2);
const long = [];
for (let i=0;i<40;i++) long.push({ role: i%2 ? 'assistant':'user', content:'x'.repeat(2000) });
const saved = S.writeChatHistory_(long);
ok('trims a transcript to fit the property cap', JSON.stringify(saved).length < 9000, JSON.stringify(saved).length + ' bytes');
ok('truncates individual messages', saved.every(m => m.content.length <= 1200));
ok('keeps the most recent exchanges', saved.length >= 2);
S.PropertiesService.getScriptProperties().setProperty('CHAT_HISTORY','{{{not json');
ok('a corrupt transcript reads as empty rather than throwing', S.readChatHistory_().length === 0);
S.PropertiesService.getScriptProperties().setProperty('CHAT_HISTORY', JSON.stringify([{role:'system',content:'x'},{role:'user',content:'ok'}]));
ok('drops roles the API would reject', S.readChatHistory_().length === 1 && S.readChatHistory_()[0].role === 'user');

// --- tool labels ---------------------------------------------------------
ok('labels a history lookup', has(S.describeAiTool_({name:'get_player_history',input:{player:'Saka'}}),'Saka'));
ok('labels a search with its filters', has(S.describeAiTool_({name:'search_players',input:{position:'MID',max_price:7}}),'MIDs'));

console.log(fail?'\n'+fail+' FAILURE(S)':'\nall checks passed');
process.exit(fail?1:0);
