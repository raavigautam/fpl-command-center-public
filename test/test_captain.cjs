const S = require(require('path').join(__dirname, 'harness.cjs'));
let fail=0;
function ok(n,c,x){console.log((c?'  PASS  ':'  FAIL  ')+n+(x!==undefined?'  '+x:''));if(!c)fail++;}
function has(s,t){return String(s).indexOf(t)!==-1;}

// --- distribution shaping -------------------------------------------------
function log(pts){ return { history: pts.map(p => ({ minutes: 90, total_points: p })) }; }

const d = S.buildDistribution_({element_type:3}, log([2,2,12,2,5,2,9,2]), 5.0, 1.0);
const mean = d.samples.reduce((a,b)=>a+b,0)/d.samples.length;
ok('rescales a match log to the projected mean', Math.abs(mean-5.0)<1e-9, mean.toFixed(4));
ok('uses the player own log when long enough', d.source==='log' && d.matches===8);

// Shape (coefficient of variation) must survive rescaling — that is the whole point.
const raw=[2,2,12,2,5,2,9,2];
const rawMean=raw.reduce((a,b)=>a+b,0)/raw.length;
const cv=(xs)=>{const m=xs.reduce((a,b)=>a+b,0)/xs.length;return Math.sqrt(xs.reduce((s,v)=>s+(v-m)*(v-m),0)/xs.length)/m;};
ok('rescaling preserves the shape', Math.abs(cv(d.samples)-cv(raw))<1e-9, cv(d.samples).toFixed(4)+' vs '+cv(raw).toFixed(4));

const short = S.buildDistribution_({element_type:4}, log([6,2]), 5.0, 1.0);
ok('falls back to a positional template when the log is short', short.source==='template');
const gk = S.buildDistribution_({element_type:1}, null, 5.0, 1.0);
const fwd = S.buildDistribution_({element_type:4}, null, 5.0, 1.0);
ok('forwards are modelled as longer-tailed than keepers', cv(fwd.samples)>cv(gk.samples),
   'FWD cv '+cv(fwd.samples).toFixed(2)+' vs GKP '+cv(gk.samples).toFixed(2));

// The unconditional mean must land back on the quoted xP once blanks fold in.
const risky = S.buildDistribution_({element_type:3}, log([2,2,12,2,5,2,9,2]), 4.0, 0.5);
const condMean = risky.samples.reduce((a,b)=>a+b,0)/risky.samples.length;
ok('a rotation risk gets a higher conditional mean', Math.abs(condMean-8.0)<1e-9, condMean.toFixed(3));
const rnd = S.seededRandom_(42);
let acc=0, N=60000;
for(let i=0;i<N;i++) acc += S.drawPoints_(risky, rnd);
ok('simulated unconditional mean matches the quoted xP', Math.abs(acc/N-4.0)<0.15, (acc/N).toFixed(3));

// --- determinism ----------------------------------------------------------
const a=S.seededRandom_(7), b=S.seededRandom_(7);
ok('the PRNG is deterministic for a seed', [0,0,0,0,0].every(()=>a()===b()));
ok('different seeds diverge', S.seededRandom_(7)()!==S.seededRandom_(8)());

// --- the headline claim -------------------------------------------------
// Mean ordering and win ordering diverge. Head to head between two players a
// steady scorer wins most weeks, so the effect only shows against a full XI,
// where topping it means beating ten others and a quiet 6 no longer does.
const metronome = { pick:{id:1,name:'Metronome',elementType:3,xp:{next:6.0}}, dist:S.buildDistribution_({element_type:3}, log([6,5,6,6,5,6,6,5]), 6.0, 1.0) };
const boomer    = { pick:{id:2,name:'Boomer',   elementType:4,xp:{next:5.5}}, dist:S.buildDistribution_({element_type:4}, log([2,2,16,2,2,13,2,2]), 5.5, 1.0) };

const twoUp = S.simulateCaptaincy_([metronome, boomer], {}, null, 123);
ok('head to head the steady scorer wins more weeks', twoUp[0].topShare > twoUp[1].topShare,
   'metronome '+(twoUp[0].topShare*100).toFixed(1)+'% vs boomer '+(twoUp[1].topShare*100).toFixed(1)+'%');
ok('top shares sum to one', Math.abs(twoUp[0].topShare+twoUp[1].topShare-1)<1e-9);

// Nine other squad members with REAL week-to-week variance. This matters:
// give the rest of the XI near-constant scores and they never top it, which
// collapses the eleven-man case back to a head-to-head and hides the effect.
const others = [];
for (let i=0;i<9;i++){
  others.push({ pick:{id:20+i,name:'Sq'+i,elementType:3,xp:{next:4.4}},
                dist:S.buildDistribution_({element_type:3}, log([4,6,2,7,3,5,4,5]), 4.4, 1.0) });
}

// Same mean, different shape: isolates variance from level.
const steadyEq = { pick:{id:11,name:'SteadyEq',elementType:3,xp:{next:5.5}}, dist:S.buildDistribution_({element_type:3}, log([5,5,6,5,5,6,5,5]), 5.5, 1.0) };
const eq = S.simulateCaptaincy_([steadyEq, boomer].concat(others), {}, null, 99);
ok('at equal means the boom-bust player tops the XI far more often',
   eq[1].topShare > eq[0].topShare * 2,
   'boomy '+(eq[1].topShare*100).toFixed(1)+'% vs steady '+(eq[0].topShare*100).toFixed(1)+'% at identical 5.5 means');

// The review's actual claim: a HIGHER-mean steady player still tops it less.
const xi = S.simulateCaptaincy_([metronome, boomer].concat(others), {}, null, 99);
ok('a lower-mean boom-bust player tops the XI more often than a higher-mean steady one',
   xi[1].topShare > xi[0].topShare,
   'boomer '+(xi[1].topShare*100).toFixed(1)+'% (mean 5.5) vs metronome '+(xi[0].topShare*100).toFixed(1)+'% (mean 6.0)');
ok('mean ordering and win ordering genuinely disagree — the premise of this whole model',
   metronome.pick.xp.next > boomer.pick.xp.next && xi[1].topShare > xi[0].topShare);
ok('every top share is a probability and they sum to one',
   Math.abs(xi.reduce((s,r)=>s+r.topShare,0)-1)<1e-9 && xi.every(r=>r.topShare>=0&&r.topShare<=1));
ok('no single player dominates a realistic XI',
   xi.every(r=>r.topShare<0.5), 'max '+(Math.max(...xi.map(r=>r.topShare))*100).toFixed(1)+'%');

// --- field comparison -----------------------------------------------------
const fieldShares=[{id:99,name:'Template',weight:1.0}];
const fieldDists={99:S.buildDistribution_({element_type:3}, log([6,5,6,6,5,6,6,5]), 6.0, 1.0)};
const sim2=S.simulateCaptaincy_([metronome,boomer],fieldDists,fieldShares,123);
ok('delta is reported against the field', sim2[0].deltaMean!==null && sim2[1].deltaMean!==null);
ok('captaining the same player as the field nets roughly zero',
   Math.abs(sim2[0].deltaMean)<0.6, sim2[0].deltaMean.toFixed(2));
ok('a differential has the wider spread between its bad and good weeks',
   (sim2[1].deltaCeiling-sim2[1].deltaFloor) > (sim2[0].deltaCeiling-sim2[0].deltaFloor),
   'boomer spread '+(sim2[1].deltaCeiling-sim2[1].deltaFloor).toFixed(1)+' vs '+(sim2[0].deltaCeiling-sim2[0].deltaFloor).toFixed(1));
ok('the differential ceiling actually captures the hauls', sim2[1].deltaCeiling > 8,
   'ceiling '+sim2[1].deltaCeiling.toFixed(1));
ok('and its floor records what the quiet weeks cost', sim2[1].deltaFloor < -4,
   'floor '+sim2[1].deltaFloor.toFixed(1));
ok('floor is below ceiling for every candidate', sim2.every(s=>s.deltaFloor<=s.deltaCeiling));

// --- tail means -----------------------------------------------------------
const asc=[0,1,2,3,4,5,6,7,8,9];
ok('lower tail mean averages the worst share', S.tailMean_(asc,0.3,false)===1, S.tailMean_(asc,0.3,false));
ok('upper tail mean averages the best share', S.tailMean_(asc,0.3,true)===8, S.tailMean_(asc,0.3,true));
ok('tail mean over everything is the plain mean', Math.abs(S.tailMean_(asc,1,true)-4.5)<1e-9);
ok('tail mean of an empty sample is zero', S.tailMean_([],0.25,true)===0);
ok('a single-element tail still returns a value', S.tailMean_([7],0.01,true)===7);

// --- risk appetite actually changes the pick ------------------------------
S.projectPoints_ = function(el){ return {next:el.__xp, horizon:el.__xp*6, perGw:[{event:11,xp:el.__xp,fixtures:1,opponents:['ARS']}], availability:1, starter:1}; };
S.fetchElementSummaries_ = function(ids){
  const out={};
  ids.forEach(id=>{ out[id] = LOGS[id] || log([4,4,4,4,4,4,4,4]); });
  return out;
};
const LOGS = {
  1: log([6,5,6,6,5,6,6,5]),      // metronome, steady
  2: log([2,2,16,2,2,13,2,2]),    // boomer
  3: log([5,5,5,5,5,5,5,5])       // filler
};
function mk(id,name,xp,type,own){
  return { id, name, team:'ARS', elementType:type, position:'MID', selectedBy:own, penaltiesOrder:null,
    chanceOfPlaying:null, form:'5.0', isStarting:true, isCaptain:false,
    xp:{next:xp,horizon:xp*6,perGw:[{event:11,xp,fixtures:1,opponents:['ARS']}],availability:1,starter:1} };
}
const squad={ starting:[mk(1,'Metronome',6.0,3,60), mk(2,'Boomer',5.5,4,8), mk(3,'Filler',5.0,3,20)] };
squad.players=squad.starting;

// The field captains the metronome almost universally.
const eo={ managersCounted:10, captainShares:[{id:1,name:'Metronome',captained:90,elementType:3,xpNext:6.0,playRate:1}],
           captainSharesById:{1:{id:1,name:'Metronome',captained:90,elementType:3,xpNext:6.0,playRate:1}} };

const safe=S.suggestCaptain_(squad,{}, 'safe', eo, 11);
const bal =S.suggestCaptain_(squad,{}, 'balanced', eo, 11);
const aggr=S.suggestCaptain_(squad,{}, 'aggressive', eo, 11);
console.log('    safe -> '+safe[0].name+' | balanced -> '+bal[0].name+' | aggressive -> '+aggr[0].name);
ok('safe protects the floor by matching the field', safe[0].name==='Metronome', safe[0].name);
ok('aggressive chases the ceiling with the differential', aggr[0].name==='Boomer', aggr[0].name);
ok('risk appetite genuinely changes the pick', safe[0].name!==aggr[0].name);

ok('every candidate reports a simulated top share', safe.every(c=>typeof c.topShare==='number'));
ok('the pick reports how often it beats the field', safe[0].beatFieldShare!==null);
ok('confidence comes from the simulated margin', ['Clear','Slight edge','Coin flip','Low'].indexOf(safe[0].confidence)!==-1, safe[0].confidence);
ok('the reason cites the simulation', has(aggr[0].reason,'simulations'), aggr[0].reason.slice(0,90));
ok('the reason says where the shape came from', has(aggr[0].reason,'last 8 appearances'));
ok('a rank pick that differs from the points pick says so',
   !!aggr[0].disagreesWithMean && has(aggr[0].disagreesWithMean.note,'Metronome'),
   aggr[0].disagreesWithMean && aggr[0].disagreesWithMean.note.slice(0,80));
ok('the basis line names what it ranked on', has(safe[0].basis,'rank movement'));

// --- graceful degradation -------------------------------------------------
const noLeague=S.suggestCaptain_(squad,{}, 'balanced', null, 11);
ok('works with no league data at all', noLeague.length===3 && noLeague[0].beatFieldShare===null);
ok('falls back to points ordering without a field', noLeague[0].name==='Metronome', noLeague[0].name);
ok('says why it could not use rank', has(noLeague[0].basis,'no league captaincy data'));

// A blank gameweek must not be captained.
const blankSquad={ starting:[
  { id:4,name:'Blank',team:'X',elementType:3,position:'MID',selectedBy:5,penaltiesOrder:null,chanceOfPlaying:null,form:'5',isStarting:true,
    xp:{next:0,horizon:0,perGw:[{event:11,xp:0,fixtures:0,opponents:[]}],availability:1,starter:1} },
  mk(2,'Boomer',5.5,4,8) ] };
blankSquad.players=blankSquad.starting;
const blank=S.suggestCaptain_(blankSquad,{}, 'balanced', null, 11);
ok('a blanking player is excluded from candidates', blank[0].name==='Boomer', blank[0].name);

// Determinism across repeated calls — the product-critical property.
const r1=S.suggestCaptain_(squad,{}, 'aggressive', eo, 11);
const r2=S.suggestCaptain_(squad,{}, 'aggressive', eo, 11);
ok('the same gameweek gives the same answer every load',
   r1[0].name===r2[0].name && r1[0].topShare===r2[0].topShare);

console.log(fail?'\n'+fail+' FAILURE(S)':'\nall checks passed');
process.exit(fail?1:0);
