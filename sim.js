const E=require('./engine.js');const PL=+(process.argv[2]??1),BL=+(process.argv[3]??1);
function simPA(st, stats, pH, bH){
  st.balls=0; st.strikes=0; st.history=[];
  let pitches=0;
  while(true){
    pitches++;
    const c=E.cpuChoosePitch(st,pH,bH,PL);
    const p=E.executePitch(c.type,c.tx,c.ty,pH,PL);
    const d=E.cpuBatter(p,st,bH,BL);
    st.history.push(p);
    let ev=null, bb=null;
    if(!d.swing){ const call=E.callPitch(p,bH); if(call==='hbp') ev='HBP'; else if(call==='ball'){ if(++st.balls===4) ev='BB'; } else { if(++st.strikes===3) ev='K'; } }
    else if(d.result==='miss'){ if(++st.strikes===3) ev='K'; }
    else if(d.result==='foul'){ if(st.strikes<2) st.strikes++; }
    else { bb=E.resolveBattedBall(d.ev,d.la,d.spray); if(bb.result==='FOUL'){ if(st.strikes<2) st.strikes++; } else ev=bb.result; }
    if(ev){ const r=E.applyEvent(st,ev,bb); E.recordPA(stats,'batter',ev,r.runs,r.outs,bb); E.recordPA(stats,'pitcher',ev,r.runs,r.outs,bb); stats.pitcher.pitches+=pitches; if(r.ended) E.nextInning(st); return {ev,bb}; }
  }
}
const st=E.newState(), stats=E.newStats(); const kinds={}; const hits={};
let bip=0, bipH=0;
for(let i=0;i<60000;i++){ const pH=Math.random()<0.7?'R':'L', bH=Math.random()<0.6?'R':'L'; const {ev,bb}=simPA(st,stats,pH,bH);
  if(bb && ev!=='HR'){ bip++; if(ev!=='OUT') bipH++; kinds[bb.kind]=kinds[bb.kind]||[0,0]; kinds[bb.kind][0]++; if(ev!=='OUT') kinds[bb.kind][1]++; }
  hits[ev]=(hits[ev]||0)+1; }
const d=E.derived(stats), b=stats.batter, p=stats.pitcher;
console.log(`AVG ${d.avg.toFixed(3)} OBP ${d.obp.toFixed(3)} SLG ${d.slg.toFixed(3)} OPS ${d.ops.toFixed(3)}`);
console.log(`K% ${(b.K/b.PA*100).toFixed(1)} BB% ${(b.BB/b.PA*100).toFixed(1)} HR% ${(b.HR/b.PA*100).toFixed(2)} BABIP ${(bipH/bip).toFixed(3)} ERA ${d.era.toFixed(2)} P/PA ${(p.pitches/p.BF).toFixed(2)}`);
console.log(hits); for(const k in kinds) console.log(k, kinds[k][0], (kinds[k][1]/kinds[k][0]).toFixed(3));
// plate discipline diag
let n=0,z=0,zs=0,os=0,zc=0,oc=0;
const st2=E.newState();
for(let i=0;i<100000;i++){ st2.balls=Math.floor(Math.random()*4); st2.strikes=Math.floor(Math.random()*3); st2.history=[];
 const c=E.cpuChoosePitch(st2,'R','R'); const p=E.executePitch(c.type,c.tx,c.ty,'R'); const d=E.cpuBatter(p,st2,'R'); const iz=E.inZone(p.px,p.py);
 n++; if(iz){z++; if(d.swing){zs++; if(d.result!=='miss')zc++;}} else { if(d.swing){os++; if(d.result!=='miss')oc++;}} }
console.log(`Zone% ${(z/n*100).toFixed(1)} Z-Swing ${(zs/z*100).toFixed(1)} O-Swing ${(os/(n-z)*100).toFixed(1)} Z-Contact ${(zc/zs*100).toFixed(1)} O-Contact ${(oc/os*100).toFixed(1)}`);
