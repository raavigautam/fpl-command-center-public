const S = require(require('path').join(__dirname, 'harness.cjs'));
let fail=0;
function ok(n,c,x){console.log((c?'  PASS  ':'  FAIL  ')+n+(x!==undefined?'  '+x:''));if(!c)fail++;}

const props=S.PropertiesService.getScriptProperties();
function reset(){ Object.keys(props.getProperties()).forEach(k=>props.deleteProperty(k)); S.CALIBRATION_=null;
  S.CacheService.getScriptCache().remove('CALIBRATION_V2'); }

/* Write `n` graded gameweeks where every position's actual is `ratio` x the
   prediction — a clean, known bias for the reader to recover. */
function seed(n, ratio, samplesPerPos){
  reset();
  for(let i=1;i<=n;i++){
    const byPosition={};
    [1,2,3,4].forEach(pos=>{ const pred=10*(samplesPerPos||5);
      byPosition[pos]={predicted:pred, actual:Math.round(pred*(ratio[pos]!==undefined?ratio[pos]:ratio.all)), n:samplesPerPos||5}; });
    // alignedProjections: the grade's predictions were made FOR the gameweek
    // they are scored against. buildCalibration_ refuses to learn without it.
    const predicted=Object.keys(byPosition).reduce((s,k)=>s+byPosition[k].predicted,0);
    const actual=Object.keys(byPosition).reduce((s,k)=>s+byPosition[k].actual,0);
    props.setProperty('GRADE_'+i, JSON.stringify({eventId:i, calibration:{byPosition, predicted, actual, n:4*(samplesPerPos||5), alignedProjections:true, version:2}}));
  }
  S.CALIBRATION_=null; S.CacheService.getScriptCache().remove('CALIBRATION_V2');
}

/* ---------- reading the bias back ---------- */
seed(12,{all:1.2});
let cal=S.buildCalibration_();
ok('reads every graded gameweek', cal.gwsGraded===12, cal.gwsGraded);
ok('recovers a known overall bias', Math.abs(cal.bias-1.2)<0.01, cal.bias);
ok('recovers it per position', [1,2,3,4].every(p=>Math.abs(cal.positions[p].bias-1.2)<0.01));
ok('names the positions readably', cal.positions[2].position==='DEF', cal.positions[2].position);
ok('keeps a per-gameweek series', cal.series.length>0 && cal.series[0].event!=null);
ok('the series records the miss', Math.abs(cal.series[0].diff-cal.series[0].predicted*0.2)<0.6, JSON.stringify(cal.series[0]));

/* ---------- the correction is conservative ---------- */
seed(2,{all:1.5});
ok('too little evidence applies no correction at all', S.calibrationFactorFor_(3)===1,
   'trust '+(S.buildCalibration_()||{}).trust);
ok('and says so', S.buildCalibration_().applied===false);

seed(5,{all:1.5});
const early=S.calibrationFactorFor_(3);
seed(20,{all:1.5});
const late=S.calibrationFactorFor_(3);
ok('a young correction is timid', early>1 && early<late, 'GW5 '+early.toFixed(3)+' vs GW20 '+late.toFixed(3));
ok('it grows toward the measured bias with evidence', late>1.2, late.toFixed(3));
ok('but is clamped so it can never run away', late<=1.25+1e-9, late.toFixed(3));

seed(20,{all:0.5});
ok('a hot model is corrected downward', S.calibrationFactorFor_(3)<1, S.calibrationFactorFor_(3));
ok('and clamped on that side too', S.calibrationFactorFor_(3)>=0.75-1e-9, S.calibrationFactorFor_(3));

/* ---------- positions are corrected independently ---------- */
seed(20,{1:1.0,2:1.3,3:1.0,4:1.0});
const def=S.calibrationFactorFor_(2), mid=S.calibrationFactorFor_(3);
ok('a biased position is corrected on its own numbers', def>mid, 'DEF '+def.toFixed(3)+' MID '+mid.toFixed(3));
ok('an unbiased position is left near where it was', Math.abs(mid-1)<0.06, mid.toFixed(3));

/* ---------- thin positional evidence falls back to the overall bias ---------- */
seed(20,{all:1.2},1); // 1 sample per position per week = 20 total, above the floor
ok('a position with enough samples uses its own bias', S.calibrationFactorFor_(3)>1);

/* ---------- version-1 grades are not evidence about the raw model ---------- */
seed(12,{all:1.5});
Object.keys(props.getProperties()).forEach(k=>{ const g=JSON.parse(props.getProperty(k)); delete g.calibration.version; props.setProperty(k, JSON.stringify(g)); });
S.CALIBRATION_=null;
ok('grades from the squad-only, calibrated-input loop are ignored', S.buildCalibration_()===null);

/* ---------- degradation ---------- */
reset();
ok('no graded history yields no calibration', S.buildCalibration_()===null);
ok('and no correction', S.calibrationFactorFor_(3)===1);
props.setProperty('GRADE_1','{{{not json');
S.CALIBRATION_=null;
ok('a corrupt grade does not throw', S.calibrationFactorFor_(3)===1);
reset();
props.setProperty('GRADE_1', JSON.stringify({eventId:1})); // graded, but no calibration block
S.CALIBRATION_=null;
ok('a grade with no calibration block is skipped', S.buildCalibration_()===null);

/* ---------- projections carry the correction ---------- */
seed(20,{all:1.2});
S.SEASON_CONTEXT_={finishedGws:20};
S.TEAM_STRENGTH_NORM_=null;
const el={id:1,element_type:3,team:1,ep_next:'5.0',form:'5.0',points_per_game:'5.0',minutes:1800,status:'a',
  chance_of_playing_next_round:null,expected_goal_involvements:'9',selected_by_percent:'10'};
const fe={1:{eventIds:[11],fixturesByEvent:{11:[{event:11,opponent:2,home:true,difficulty:3}]},blankGws:[],doubleGw:{},nextOpponents:[]}};
const withCal=S.projectPoints_(el,fe).next;
reset();
const without=S.projectPoints_(el,fe).next;
ok('a cold model projects higher once corrected', withCal>without, withCal+' vs '+without);
ok('the correction is proportionate, not a rewrite', withCal/without < 1.3, (withCal/without).toFixed(3));

console.log(fail?'\n'+fail+' FAILURE(S)':'\nall checks passed');
process.exit(fail?1:0);
