const S = require(require('path').join(__dirname, 'harness.cjs'));
let fail=0;
function ok(n,c,x){console.log((c?'  PASS  ':'  FAIL  ')+n+(x!==undefined?'  '+x:''));if(!c)fail++;}

// --- world ---------------------------------------------------------------
const teams=[{id:1,short_name:'BOU'},{id:2,short_name:'ARS'},{id:3,short_name:'LEE'}];
function el(id,name,type,team,cost){return {id,web_name:name,element_type:type,team,now_cost:cost,status:'a',
  selected_by_percent:'20.0',minutes:900,form:'5.0'};}
// 1 Saka (field template, heavily captained), 2 Semenyo (mine, differential),
// 3 Raya (mine, field also has), 4 Palmer (field has, I don't)
const elements=[el(1,'Saka',3,2,100),el(2,'Semenyo',3,1,75),el(3,'Raya',1,2,55),el(4,'Palmer',3,2,105)];
const bootstrap={teams,elements};
const XP={1:6.0,2:5.0,3:3.0,4:7.0};
S.projectPoints_=function(e){return {next:XP[e.id]||0,horizon:(XP[e.id]||0)*6,perGw:[{event:11,xp:XP[e.id]||0}]};};
const fixtureEase={};

const squad={players:[
  {id:2,name:'Semenyo',isStarting:true,isCaptain:true},   // my captain, 2x
  {id:3,name:'Raya',isStarting:true,isCaptain:false},     // my starter, 1x
]};

// 10 rivals: 9 own+start Saka and 6 of those captain him; 8 own Palmer started;
// 3 own Raya started; nobody owns Semenyo.
const picks=[];
for(let i=0;i<10;i++){
  const p=[];
  if(i<9) p.push({element:1,multiplier:i<6?2:1});
  if(i<8) p.push({element:4,multiplier:1});
  if(i<3) p.push({element:3,multiplier:1});
  picks.push({entryId:100+i,name:'R'+i,picks:p});
}
S.fetchRivalPicks_=function(){return picks;};

const miniLeague={leagueId:'99',leagueName:'The Office',
  entries:[{entryId:'ME',name:'Me'}].concat(picks.map(p=>({entryId:p.entryId,name:p.name})))};

const eo=S.buildLeagueEo_(bootstrap,fixtureEase,squad,miniLeague,'ME',10);
ok('builds a table',!!eo && !eo.unavailable, eo && eo.unavailable);
ok('counts every rival',eo.managersCounted===10,eo.managersCounted);

function row(n){return (eo.threats.concat(eo.edges)).filter(r=>r.name===n)[0];}
const saka=row('Saka');
// EO = (6 captains x2 + 3 starters x1) / 10 = 15/10 = 150%
ok('EO counts captaincy at double',saka && saka.eo===150,saka&&saka.eo);
ok('raw ownership is separate from EO',saka && saka.owned===90,saka&&saka.owned);
ok('captaincy share is reported',saka && saka.captained===60,saka&&saka.captained);
ok('a player the field has and you do not is a threat',!!eo.threats.filter(r=>r.name==='Saka')[0]);
// swing = (0 - 1.5) * 6.0 = -9.0
ok('threat swing is negative and scaled by xP',saka && Math.abs(saka.delta+9.0)<0.01,saka&&saka.delta);

const semenyo=eo.edges.filter(r=>r.name==='Semenyo')[0];
// mine=2 (captain), eo=0 -> 200-0=200 >= 50, delta=(2-0)*5.0=10
ok('your captain nobody else has is an edge',!!semenyo,JSON.stringify(eo.edges.map(r=>r.name)));
ok('edge swing is positive and doubled for the armband',semenyo && Math.abs(semenyo.delta-10.0)<0.01,semenyo&&semenyo.delta);

// Raya: mine=1 (100), field EO=30 -> 100-30=70 >= 50 -> edge. Correct, the
// field really is less exposed. But a player the field holds at 60% must NOT
// qualify, which is what the old threshold got wrong.
ok('a genuine low-owned starter is an edge',!!eo.edges.filter(r=>r.name==='Raya')[0]);
ok('the edge bar excludes near-template starters',
   S.EO_EDGE_THRESHOLD === 50, 'threshold is ' + S.EO_EDGE_THRESHOLD);

ok('net exposure sums every swing',typeof eo.net==='number');
ok('net is negative when the field is more exposed',eo.net<0,eo.net);
// Saka -9.0, Palmer -5.6, Semenyo +10.0, Raya +2.1 => -2.5, inside the band.
ok('net is the sum of every swing',Math.abs(eo.net+2.5)<0.05,eo.net);
const expectStance = eo.net > 4 ? 'aggressive' : (eo.net < -4 ? 'exposed' : 'balanced');
ok('stance follows the net',eo.stance===expectStance,eo.stance+' for net '+eo.net);
ok('the summary matches the stance',eo.summary.indexOf(eo.net>=0?'ahead':'tracks')!==-1||eo.stance==='exposed',eo.summary.slice(0,60));
ok('the basis names the gameweek the picks came from',eo.basis.indexOf('GW10')!==-1);

// A league too small to mean anything.
const tiny={leagueId:'1',leagueName:'Tiny',entries:[{entryId:'ME'},{entryId:'A'}]};
const small=S.buildLeagueEo_(bootstrap,fixtureEase,squad,tiny,'ME',10);
ok('a two-person league reports unavailable rather than nonsense',!!(small&&small.unavailable),JSON.stringify(small));
ok('no league at all returns null',S.buildLeagueEo_(bootstrap,fixtureEase,squad,null,'ME',10)===null);
ok('no locked gameweek returns null',S.buildLeagueEo_(bootstrap,fixtureEase,squad,miniLeague,'ME',null)===null);

// --- price pressure ------------------------------------------------------
function pel(id,name,inn,out,own,change){return {id,web_name:name,element_type:3,team:1,now_cost:75,status:'a',
  selected_by_percent:String(own),transfers_in_event:inn,transfers_out_event:out,cost_change_event:change||0,minutes:900};}
// 1m total players. 2% owned = 20k owners. 8k net in = 0.40 pressure -> strong.
// 45% owned = 450k owners. Same 8k net = 0.018 -> nothing. Same raw count,
// opposite verdicts: the whole point of dividing by the owner base.
const punt=pel(10,'Punt',9000,1000,2.0);
const prem=pel(11,'Premium',9000,1000,45.0);
const bs={total_players:1000000,teams,elements:[punt,prem]};
const pp=S.pricePressureFor_(punt,1000000), pq=S.pricePressureFor_(prem,1000000);
ok('a stampede into a low-owned player registers',pp&&pp.band==='strong',pp&&pp.pressure);
ok('the same raw count into a premium does not',pq===null,pq&&pq.pressure);
ok('direction is read from the sign',pp.direction==='rise');
ok('a fall is detected too',S.pricePressureFor_(pel(12,'X',1000,9000,2.0),1000000).direction==='fall');
ok('no net movement is not pressure',S.pricePressureFor_(pel(13,'Y',5000,5000,2.0),1000000)===null);
ok('an already-banked change is flagged',S.pricePressureFor_(pel(14,'Z',9000,1000,2.0,1),1000000).alreadyMoved===true);

const squad2={players:[{id:11,name:'Premium',team:'BOU',priceChangeEvent:0.1}]};
const watch=S.buildPriceWatch_(squad2,bs,[{inId:10}]);
ok('a recommended buy under pressure is the urgent row',watch.urgent&&watch.urgent.name==='Punt',JSON.stringify(watch.urgent));
ok('targets are separated from the squad',watch.targets.length===1&&watch.squad.length===0);
ok('settled changes are still reported',watch.settled.length===1);

console.log(fail?'\n'+fail+' FAILURE(S)':'\nall checks passed');
process.exit(fail?1:0);
