const S = require(require('path').join(__dirname, 'harness.cjs'));
let fail=0;
function ok(n,c,x){console.log((c?'  PASS  ':'  FAIL  ')+n+(x!==undefined?'  '+x:''));if(!c)fail++;}
function has(s,t){return String(s).indexOf(t)!==-1;}

const GWS=[10,11,12,13,14,15];
function player(id,type,perGw,status){
  return { id, name:'P'+id, elementType:type, teamId:1, team:'BOU', status:status||'a',
    xp:{ next:perGw[0], horizon:perGw.reduce((a,b)=>a+b,0),
         perGw:GWS.map((g,i)=>({event:g,xp:perGw[i],fixtures:1,opponents:['ARS']})) } };
}
// Bench projects 3 normally; in GW12 (index 2) it spikes to 20.
const bench=[player(1,1,[1,1,4,1,1,1]),player(2,2,[1,1,6,1,1,1]),player(3,3,[0.5,0.5,5,0.5,0.5,0.5]),player(4,3,[0.5,0.5,5,0.5,0.5,0.5])];
const starting=[]; for(let i=0;i<11;i++) starting.push(player(10+i,(i%4)+1,[4,4,4,4,4,4]));
const squad={ players:starting.concat(bench), starting, bench, bank:0.5, teamValue:100.0 };

// --- bench boost ---------------------------------------------------------
const bb=S.valueBenchBoost_(squad,GWS);
ok('finds the gameweek the bench peaks in', bb.bestEvent===12, 'GW'+bb.bestEvent);
ok('values it as the bench total', Math.abs(bb.bestValue-20)<0.01, bb.bestValue);
ok('reports what it is worth this week too', Math.abs(bb.thisWeek-3)<0.01, bb.thisWeek);

// --- triple captain ------------------------------------------------------
const capHolder=player(99,4,[6,6,6,15,6,6]);
capHolder.name='Haaland';
squad.starting.push(capHolder);
const tc=S.valueTripleCaptain_(squad,[{name:'Haaland',xp:6,deltaCeiling:9}],GWS);
ok('finds the captain peak gameweek', tc.bestEvent===13, 'GW'+tc.bestEvent);
ok('values a third helping at his projection there', Math.abs(tc.bestValue-15)<0.01, tc.bestValue);
ok('reports a ceiling above the mean', tc.ceiling>tc.bestValue, tc.ceiling+' vs '+tc.bestValue);
ok('names the player', tc.name==='Haaland');
squad.starting.pop();

// --- board: values drive status -----------------------------------------
const values={ eventIds:GWS,
  benchBoost:{bestEvent:12,bestValue:20,thisWeek:3,detail:'Bench projects 20.0 in GW12.'},
  tripleCaptain:{name:'Haaland',bestEvent:13,bestValue:15,thisWeek:6,isDouble:true,ceiling:19,detail:'A third helping is worth 15.0 in GW13.'},
  freeHit:{bestEvent:14,gain:20,ideal:70,mine:50,ceiling:88,detail:'In GW14 your best legal eleven projects 50.0; the best a Free Hit could buy projects 70.0.'},
  wildcard:{gain:30,rebuilt:400,mine:370,flagged:1,detail:'A rebuilt squad projects 400.0; yours 370.0.'} };
let board=S.buildChipBoard_([], {}, squad, [], {id:10}, values);
function slot(l){ return board.filter(b=>b.label===l)[0]; }
ok('every slot carries a point value', ['Bench Boost','Triple Captain','Free Hit'].every(l=>slot(l).value!=null),
   JSON.stringify(board.map(b=>b.label+'='+b.value)));
ok('bench boost targets its peak gameweek', slot('Bench Boost').status==='Target GW12', slot('Bench Boost').status);
ok('triple captain targets its peak gameweek', slot('Triple Captain').status==='Target GW13', slot('Triple Captain').status);
ok('the triple captain detail cites the ceiling', has(slot('Triple Captain').detail,'19.0'));
ok('free hit reports the unconstrained ceiling separately', has(slot('Free Hit').detail,'Ignoring budget entirely'));
ok('a clearing wildcard says play now', slot('Wildcard 1').status==='Play now', slot('Wildcard 1').status);

// When the peak IS this gameweek, it says play now.
board=S.buildChipBoard_([], {}, squad, [], {id:12}, values);
// Both Bench Boost (20 vs 14) and the Wildcard (30 vs 15) clear their bars
// this week — but only one chip can be played in a gameweek.
ok('only one chip is ever Play now', board.filter(b=>b.status==='Play now').length===1,
   JSON.stringify(board.map(b=>b.label+'='+b.status)));
ok('the one that clears its bar by more wins', slot('Wildcard 1').status==='Play now' && slot('Bench Boost').status==='Hold');
ok('the loser says why it waits', has(slot('Bench Boost').detail,'Only one chip'));
const decision=S.buildChipDecision_(board);
ok('the chip decision names one chip', decision.play==='Wildcard 1', JSON.stringify(decision));
ok('and says it replaces the transfers', decision.replacesTransfers && has(decision.reason,'replaces'));
const noWc=JSON.parse(JSON.stringify(values)); noWc.wildcard.gain=5;
board=S.buildChipBoard_([], {}, squad, [], {id:12}, noWc);
ok('a chip peaking this week reads Play now', slot('Bench Boost').status==='Play now', slot('Bench Boost').status);
ok('holding everything is a decision with a reason', has(S.buildChipDecision_([{label:'Bench Boost',status:'Hold'}]).reason,'Hold every chip'));

// A value past the plausibility line is a sign of a bug, not an offer.
const silly=JSON.parse(JSON.stringify(values)); silly.wildcard.gain=221;
board=S.buildChipBoard_([], {}, squad, [], {id:10}, silly);
ok('an implausible wildcard is not Play now', slot('Wildcard 1').status==='Check', slot('Wildcard 1').status);
ok('and says why', has(slot('Wildcard 1').detail,'inflated'));

// The Wildcard is measured against the plan it would replace.
const wcv={wildcard:{gain:40,rebuilt:400,mine:360,flagged:0,detail:'x'}};
S.rebaseWildcardOnPlan_(wcv,{weeks:[{squadXp:200,hits:0},{squadXp:190,hits:1}]});
ok('the baseline is the better of the squad and the plan', wcv.wildcard.mine===386 && wcv.wildcard.baseline==='plan', JSON.stringify(wcv.wildcard));
ok('so the gain shrinks to the margin over the plan', wcv.wildcard.gain===14, wcv.wildcard.gain);
ok('and still reconciles', Math.abs(wcv.wildcard.rebuilt-wcv.wildcard.mine-wcv.wildcard.gain)<0.11);
const wcv2={wildcard:{gain:40,rebuilt:400,mine:360,flagged:0,detail:'x'}};
S.rebaseWildcardOnPlan_(wcv2,{weeks:[{squadXp:100,hits:0}]});
ok('a plan worse than holding leaves the squad as the baseline', wcv2.wildcard.mine===360 && wcv2.wildcard.baseline==='squad');

// Below the bar it holds AND says how short.
const weak={ eventIds:GWS,
  benchBoost:{bestEvent:12,bestValue:6,thisWeek:3,detail:'Bench projects 6.0 in GW12.'},
  tripleCaptain:{name:'X',bestEvent:11,bestValue:5,thisWeek:5,isDouble:false,ceiling:null,detail:'Worth 5.0.'},
  freeHit:{bestEvent:14,gain:3,ideal:53,mine:50,detail:'Gain 3.0.'},
  wildcard:{gain:2,rebuilt:372,mine:370,flagged:0,detail:'Rebuild gains 2.0.'} };
board=S.buildChipBoard_([], {}, squad, [], {id:12}, weak);
ok('an underpowered chip holds', slot('Bench Boost').status==='Hold', slot('Bench Boost').status);
ok('and says what it is short of', has(slot('Bench Boost').detail,'short of the'), slot('Bench Boost').detail.slice(-70));
ok('a weak wildcard holds and quantifies it', slot('Wildcard 1').status==='Hold' && has(slot('Wildcard 1').detail,'short of'));

// Used chips stay used.
board=S.buildChipBoard_([{name:'bboost',event:7},{name:'wildcard',event:4}], {}, squad, [], {id:12}, values);
ok('a played chip reports as used', slot('Bench Boost').status==='Used' && has(slot('Bench Boost').detail,'GW7'));
ok('a played wildcard fills the first slot', slot('Wildcard 1').status==='Used');
ok('every board has exactly five slots', board.length===5);

// --- prose matches the numbers -------------------------------------------
const notes=S.suggestChips_({}, [], {}, squad, [], [], values);
ok('prose quotes the bench figure', notes.some(n=>has(n,'20.0')), notes[0]);
ok('prose quotes the free hit comparison', notes.some(n=>has(n,'70.0')&&has(n,'50.0')));
ok('prose never claims a chip on one doubling player', !notes.some(n=>has(n,'strong Triple Captain candidate')));
const weakNotes=S.suggestChips_({}, [], {}, squad, [], [], weak);
ok('weak values produce hold advice', weakNotes.every(n=>has(n,'Hold')||has(n,'hold')||has(n,'under the')||has(n,'below the')),
   weakNotes.join(' | ').slice(0,150));
ok('used chips drop out of the prose', S.suggestChips_({}, [], {}, squad, [{name:'bboost',event:7},{name:'bboost',event:9}], [], values)
   .every(n=>!has(n,'Bench Boost')));

// --- degradation ---------------------------------------------------------
ok('no values at all still returns a full board', S.buildChipBoard_([], {}, squad, [], {id:12}, null).length===5);
ok('no values produces an honest note', has(S.suggestChips_({}, [], {}, squad, [], [], null)[0],'No chip is worth playing'));

// --- best XI from pools --------------------------------------------------
const pools={1:[6,1],2:[5,4,3,2,1],3:[9,8,7,2,1],4:[10,3,1]};
// 6 + (5+4+3) + (9+8) + 10 + best four of the rest {7,3,2,2}
ok('best XI from pools respects the formation bounds', S.bestXiFromPools_(pools)===59, S.bestXiFromPools_(pools));

console.log(fail?'\n'+fail+' FAILURE(S)':'\nall checks passed');
process.exit(fail?1:0);
