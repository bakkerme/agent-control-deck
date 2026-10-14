import { useEffect, useState } from "react";
import type { MatchingAnalyticsSummary } from "../shared/matching-analytics";
import { message } from "./components";
const ms = (value: number | null) => value === null ? "Unavailable" : `${Math.round(value)} ms`;
export default function MatchingAnalytics({ initial }: { initial: MatchingAnalyticsSummary }) {
  const [days,setDays]=useState<1|7|30>(7), [data,setData]=useState(initial), [notice,setNotice]=useState("");
  useEffect(()=>{
    let active=true;
    if(days===7) setData(initial);
    else void window.deck.matchingAnalytics(days).then(value=>{if(active)setData(value);}).catch(e=>{if(active)setNotice(message(e));});
    return ()=>{active=false;};
  },[days,initial]);
  const download = async (format: "json" | "html") => {
    try {
      const json=await window.deck.exportMatchingAnalytics(days);
      const escape=(text:string)=>text.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
      const body=format==="json"?json:`<!doctype html><meta charset="utf-8"><title>Local matching summary</title><style>body{font:16px/1.5 system-ui;margin:32px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Local matching summary</h1><p>Aggregate metrics only. Removals are feedback, not confirmed errors. Explicit accuracy reviews are not available in this MVP.</p><pre>${escape(json)}</pre>`;
      const url=URL.createObjectURL(new Blob([body],{type:format==="json"?"application/json":"text/html"}));
      const a=document.createElement("a");a.href=url;a.download=`matching-summary-${days}days.${format}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
      setNotice("Summary export requested");
    } catch(e){setNotice(message(e));}
  };
  return <section aria-label="Local performance and feedback" className="matching-analytics">
    <h4>Local performance and feedback</h4>
    {data.collectionIncomplete&&<p role="alert">Some analytics could not be recorded; these counts are incomplete.</p>}
    <label>Time window<select value={days} onChange={e=>setDays(Number(e.target.value) as 1|7|30)}><option value={1}>Last 24 hours</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option></select></label>
    <p>{data.chats} chats assessed · {data.assessments} assessments · {data.outcomes.linked??0} links applied · {(data.outcomes.no_match??0)+(data.outcomes.uncertain??0)+(data.outcomes.insufficient_context??0)} abstentions · {data.outcomes.error??0} errors</p>
    <p>{data.feedback.removed} automatic links removed · {data.feedback.manuallyLinked} manual links added · {data.feedback.undoRestored} links restored by Undo</p>
    <p className="muted">Removed links are feedback, not confirmed errors. Accuracy and recall are unavailable until examples are explicitly reviewed. History stays on this computer; no chat text is copied into metrics.</p>
    {data.configurations.length ? <div className="matching-table"><table><thead><tr><th>Model / threads</th><th>Samples</th><th>Model median / p95</th><th>Queue p95</th><th>Since queued p95</th><th>Peak RAM</th></tr></thead><tbody>{data.configurations.map(c=><tr key={c.identity}>
      <td>{c.model}{c.threads!==null?` / ${c.threads}`:""}<small>Policy {c.policy.likelihood} / {c.policy.margin} / {c.policy.context??"native"}</small></td>
      <td>{c.warmSamples} / {c.samples}</td><td>{ms(c.inferenceP50Ms)} / {ms(c.inferenceP95Ms)}</td><td>{ms(c.waitP95Ms)}</td><td>{ms(c.endToEndP95Ms)}</td><td>{c.peakRssBytes===null?"Unavailable":`${(c.peakRssBytes/2**30).toFixed(2)} GiB`}</td>
    </tr>)}</tbody></table></div>:<p className="muted">No matching measurements yet.</p>}
    <details><summary>Recent decisions</summary><ul>{data.recent.map(r=><li key={r.id}>{r.model} · {r.purpose ? "card entry · " : ""}{r.outcome} · {ms(r.inferenceMs)} model time{r.purpose ? ` · ${ms(r.endToEndMs)} total` : ""} · {new Date(r.at).toLocaleString()}</li>)}</ul></details>
    <div className="matching-actions"><button onClick={()=>void download("json")}>Export summary JSON</button><button onClick={()=>void download("html")}>Export summary report</button><button onClick={()=>void window.deck.clearMatchingAnalytics().then(()=>{setNotice("Analytics cleared; links and dismissals are preserved");}).catch(e=>setNotice(message(e)))}>Clear analytics</button></div>
    <p className="muted">Model percentiles exclude the first request after loading. Since queued includes startup when needed. Retained for 30 days, up to 10,000 assessments and feedback events. Exports contain aggregate timings, configuration and counts only.</p>
    <p aria-live="polite">{notice}</p>
  </section>;
}
