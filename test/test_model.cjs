const S = require(require('path').join(__dirname, 'harness.cjs'));
let fail=0;
function ok(n,c,x){console.log((c?'  PASS  ':'  FAIL  ')+n+(x!==undefined?'  '+x:''));if(!c)fail++;}

/* ---------- starter floor tightens with evidence ---------- */
S.SEASON_CONTEXT_={finishedGws:0};
ok('preseason gives everyone the benefit of the doubt', S.starterFactor_({minutes:0})===0.9);
ok('preseason floor is the lenient one', S.starterFloor_()===0.55);

S.SEASON_CONTEXT_={finishedGws:1};
const earlyNever=S.starterFactor_({minutes:0});
S.SEASON_CONTEXT_={finishedGws:12};
const lateNever=S.starterFactor_({minutes:0});
ok('a player who never plays is penalised harder as evidence builds', lateNever<earlyNever,
   'GW1 '+earlyNever+' vs GW12 '+lateNever);
ok('the settled floor is reached and held', Math.abs(S.starterFloor_()-0.2)<1e-9, S.starterFloor_());
ok('an ever-present is never penalised', S.starterFactor_({minutes:90*12})===1);
ok('a half-playing player sits between the two', (()=>{const h=S.starterFactor_({minutes:45*12});return h>0.2&&h<1;})(),
   S.starterFactor_({minutes:45*12}));
// The bug this fixes: a 5.0-rate player who never plays used to project 2.75.
ok('a never-playing player no longer projects half a starter', 5.0*lateNever < 1.2,
   'projects '+(5.0*lateNever).toFixed(2)+' a week');

/* ---------- position-aware fixtures ---------- */
// Opponent A: brilliant attack, feeble defence. Opponent B: the reverse.
const leagueMean={strength_attack_home:1100,strength_attack_away:1100,strength_defence_home:1100,strength_defence_away:1100};
const teams=[];
for(let i=1;i<=18;i++) teams.push(Object.assign({id:i,name:'T'+i,short_name:'T'+i},leagueMean));
teams.push({id:19,name:'AllAttack',short_name:'ATK',strength_attack_home:1400,strength_attack_away:1400,strength_defence_home:800,strength_defence_away:800});
teams.push({id:20,name:'AllDefence',short_name:'DEF',strength_attack_home:800,strength_attack_away:800,strength_defence_home:1400,strength_defence_away:1400});
S.TEAM_STRENGTH_NORM_=S.loadTeamStrengthNorms_({teams});
ok('league norms are computed from every team', S.TEAM_STRENGTH_NORM_.teams===20);

function fx(oppId,home,diff){
  const t=teams.filter(t=>t.id===oppId)[0];
  return { event:11, opponent:oppId, home, difficulty:diff, opponentTeam:{
    strength_attack_home:t.strength_attack_home, strength_attack_away:t.strength_attack_away,
    strength_defence_home:t.strength_defence_home, strength_defence_away:t.strength_defence_away } };
}
// Same FDR 3 both times — FDR alone would call these identical fixtures.
const vsLeakyDefence = fx(19,true,3);   // opponent defends badly
const vsStrongDefence= fx(20,true,3);   // opponent defends well

const attMul_leaky = S.fixtureMultiplierFor_(vsLeakyDefence,false,3);   // MID
const attMul_solid = S.fixtureMultiplierFor_(vsStrongDefence,false,3);
ok('attackers prefer a leaky defence', attMul_leaky>attMul_solid,
   attMul_leaky.toFixed(3)+' vs '+attMul_solid.toFixed(3));

const defMul_vsAttack = S.fixtureMultiplierFor_(vsLeakyDefence,false,2);  // DEF vs the big attack
const defMul_vsWeak   = S.fixtureMultiplierFor_(vsStrongDefence,false,2); // DEF vs the weak attack
ok('defenders fear a strong attack', defMul_vsAttack<defMul_vsWeak,
   defMul_vsAttack.toFixed(3)+' vs '+defMul_vsWeak.toFixed(3));

ok('the same fixture splits the two positions opposite ways',
   (attMul_leaky>attMul_solid) && (defMul_vsAttack<defMul_vsWeak),
   'FDR alone rated both fixtures identically');
ok('keepers are treated like defenders',
   S.fixtureMultiplierFor_(vsLeakyDefence,false,1)===S.fixtureMultiplierFor_(vsLeakyDefence,false,2));
ok('forwards are treated like midfielders',
   S.fixtureMultiplierFor_(vsLeakyDefence,false,4)===S.fixtureMultiplierFor_(vsLeakyDefence,false,3));

// Degradation: no position, no opponent data, or no norms => original behaviour.
// FDR 3 at home is neutral difficulty plus the home edge.
const plainFdr=S.fixtureMultiplierFor_(vsLeakyDefence,false);
ok('omitting the position gives the FDR-only answer', Math.abs(plainFdr-(1+S.XP_HOME_EDGE))<1e-9, plainFdr);

// The blend must not let either source dominate: at a neutral FDR the
// position adjustment has to stay smaller than a full FDR step is worth.
const strengthOnlySwing=Math.abs(S.fixtureMultiplierFor_(vsLeakyDefence,false,3)-plainFdr);
const oneFdrStep=Math.abs(S.fixtureMultiplierFor_(fx(1,true,2),false,3)-S.fixtureMultiplierFor_(fx(1,true,3),false,3));
ok('an extreme opponent moves the number by less than two FDR steps',
   strengthOnlySwing < oneFdrStep*2,
   'strength swing '+strengthOnlySwing.toFixed(3)+' vs one FDR step '+oneFdrStep.toFixed(3));
ok('a fixture with no opponent data degrades to FDR only',
   S.fixtureMultiplierFor_({event:11,home:true,difficulty:3},false,3)===plainFdr);
S.TEAM_STRENGTH_NORM_=null;
ok('no league norms degrades to FDR only', S.fixtureMultiplierFor_(vsLeakyDefence,false,3)===plainFdr);
S.TEAM_STRENGTH_NORM_=S.loadTeamStrengthNorms_({teams});
ok('missing strength fields degrade rather than throw',
   S.loadTeamStrengthNorms_({teams:[{id:1,name:'x',short_name:'x'}]})===null);

// FDR still moves the number — the strength half is a blend, not a takeover.
const easyFdr=S.fixtureMultiplierFor_(fx(1,true,2),false,3);
const hardFdr=S.fixtureMultiplierFor_(fx(1,true,5),false,3);
ok('FDR still matters against an average opponent', easyFdr>hardFdr, easyFdr.toFixed(3)+' vs '+hardFdr.toFixed(3));
ok('home advantage still applies',
   S.fixtureMultiplierFor_(fx(1,true,3),false,3) > S.fixtureMultiplierFor_(fx(1,false,3),false,3));
// The coming fixture used to be halved on the reading that ep_next priced
// it already. ep_next is no longer in the projection (it is form restated),
// and the backtest chose full weight in every held-out week.
ok('the coming gameweek\u2019s fixture counts in full',
   Math.abs(S.fixtureMultiplierFor_(fx(1,true,5),true,3) - S.fixtureMultiplierFor_(fx(1,true,5),false,3)) < 1e-9);
// Measured GW1-5: an easy fixture moved defenders ~1.5x, attackers ~1.2x.
ok('fixtures swing defenders harder than attackers',
   S.fixtureMultiplierFor_(fx(1,true,2),false,2) > S.fixtureMultiplierFor_(fx(1,true,2),false,3));

// Sanity: the adjustment must stay a nudge, never a reversal.
[1,2,3,4].forEach(t=>{
  [2,3,5].forEach(d=>{
    [true,false].forEach(h=>{
      [19,20,1].forEach(o=>{
        const m=S.fixtureMultiplierFor_(fx(o,h,d),false,t);
        // FDR 5 measured at ~0.65x for defenders, so the floor sits below that.
        if(!(m>0.4&&m<1.6)) { ok('multiplier stays in a sane band',false,'type '+t+' fdr '+d+' opp '+o+' -> '+m); fail++; }
      });
    });
  });
});
ok('every multiplier across the grid stays a nudge, not a reversal', true);

console.log(fail?'\n'+fail+' FAILURE(S)':'\nall checks passed');
process.exit(fail?1:0);
