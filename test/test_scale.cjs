const S = require(require('path').join(__dirname, 'harness.cjs'));
const GWS = [10,11,12,13,14,15];

S.buildFixtureSwings_ = () => [];
S.SEASON_CONTEXT_ = { finishedGws: 9 };
S.projectPoints_ = function (el) {
  const perGw = el.__perGw;
  return { next: perGw[0], horizon: perGw.reduce((a,b)=>a+b,0), perGw: GWS.map((g,i)=>({event:g, xp:perGw[i]})) };
};

function mkEl(id, type, team, cost, perGw) {
  return { id, web_name:'P'+id, team, element_type:type, now_cost:cost, status:'a', minutes:900,
    selected_by_percent:'10.0', transfers_in_event:0, transfers_out_event:0, cost_change_event:0, __perGw:perGw };
}
const teams = []; for (let t=1;t<=20;t++) teams.push({id:t,name:'T'+t,short_name:'T'+t});

// A realistic pool: ~700 players, wide quality spread.
const elements = []; let nid = 1; const mySquad = [];
[[1,2],[2,5],[3,5],[4,3]].forEach(([type,n]) => {
  for (let i=0;i<n;i++){
    const el = mkEl(nid, type, ((nid%20)+1), 50, GWS.map(()=>3));
    elements.push(el);
    mySquad.push({ id:nid, name:'P'+nid, team:'T'+el.team, teamId:el.team, position:S.POSITION_MAP[type],
      elementType:type, price:5.0, sellingPrice:5.0, isStarting:mySquad.length<11,
      isCaptain:mySquad.length===0, xp:S.projectPoints_(el) });
    nid++;
  }
});
for (let i=0;i<700;i++){
  const type=(i%4)+1;
  const base = 1 + (i % 9) * 0.7;
  elements.push(mkEl(nid++, type, ((i%20)+1), 40 + (i%60), GWS.map((_,g)=> base + ((i+g)%5)*0.4)));
}
const bootstrap = { teams, elements, events: [], total_players: 1000000 };
const fixtureEase = {}; for (let t=1;t<=20;t++) fixtureEase[t]={eventIds:GWS};
const squad = { players:mySquad, starting:mySquad.filter(p=>p.isStarting), bench:mySquad.filter(p=>!p.isStarting), bank:5.0 };

let fail=0;
function ok(n,c,x){console.log((c?'  PASS  ':'  FAIL  ')+n+(x!==undefined?'  '+x:''));if(!c)fail++;}

const runs = [];
let first = null;
for (let r=0;r<5;r++){
  const t0=Date.now();
  const plan = S.buildTransferRoadmap_(bootstrap, fixtureEase, squad, 2, 'balanced', null);
  runs.push(Date.now()-t0);
  if (r===0){
    first = plan;
    console.log('  plan:', plan.weeks.map(w=>'GW'+w.event+(w.moves.length?' '+w.moves.length+'mv'+(w.hits?' -'+w.hits*4:''):' roll')).join(' | '),
                '\n  plannedXp=', plan.plannedXp, 'hits=', plan.totalHits);
  }
}

// This fixture is rich enough that the search genuinely takes a hit-funded
// double move, which is the case that used to drive free transfers to zero
// and make the following week price a single move as another -4.
const doubles = first.weeks.filter(w => w.moves.length >= 2);
ok('the search does take a multi-move week here', doubles.length > 0, doubles.length + ' found');
ok('free transfers never fall below one',
   first.weeks.every(w => w.freeTransfers >= 1),
   JSON.stringify(first.weeks.map(w => w.freeTransfers)));
ok('hits are charged only on moves beyond the free transfers',
   first.weeks.every(w => (w.hits||0) === Math.max(0, w.moves.length - w.freeTransfers)),
   JSON.stringify(first.weeks.map(w => w.moves.length+'mv/'+w.freeTransfers+'ft/'+(w.hits||0)+'h')));
ok('a hit week is followed by at least one free transfer',
   first.weeks.every((w,i) => !w.hits || i === first.weeks.length-1 || first.weeks[i+1].freeTransfers >= 1));
ok('the plan never goes overdrawn', first.weeks.every(w => w.bank >= -0.001),
   JSON.stringify(first.weeks.map(w=>w.bank)));
console.log('  ' + elements.length + ' players, 6 GWs — times: ' + runs.join(', ') + ' ms');
const worst = Math.max(...runs);
console.log(worst < 2000 ? '\n  PASS  stays well inside the request budget ('+worst+'ms)' : '\n  FAIL  too slow ('+worst+'ms)');

// Divergence: a squad where the only good move pays off late, and the engine
// has been told to make a mediocre move now.
const late = nid;
elements.push(mkEl(nid++, 3, 7, 55, [0,0,0,20,20,20]));
const meh  = nid;
elements.push(mkEl(nid++, 3, 8, 55, [3.4,3.4,3.4,3.4,3.4,3.4]));
const plan2 = S.buildTransferRoadmap_(bootstrap, fixtureEase, squad, 1, 'balanced',
  [{ outId: mySquad[12].id, inId: meh, projectedGain: 2.4 }]);
console.log('\n  pinned GW1 =', JSON.stringify(plan2.weeks[0].moves.map(m=>m.inName)));
console.log('  divergence =', plan2.divergence ? plan2.divergence.gain + ' pts — ' + plan2.divergence.summary : 'none');
console.log(plan2.divergence ? '  PASS  divergence surfaces when the horizon disagrees' : '  (no divergence in this scenario)');
process.exit((worst < 2000 && fail === 0) ? 0 : 1);
