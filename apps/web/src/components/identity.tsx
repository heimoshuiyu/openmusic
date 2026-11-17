/** Shared print mark: stylus, record groove and two-tone wordmark. */
export function Wordmark() {
  return <span className="om-wordmark"><svg aria-hidden="true" width="26" height="26" viewBox="0 0 26 26" fill="none">
    <circle cx="12" cy="14" r="9" stroke="currentColor" strokeWidth="3"/><circle cx="12" cy="14" r="2.5" fill="currentColor"/>
    <path d="M24 2h-5v7l-6 6" stroke="currentColor" strokeWidth="3"/>
  </svg><span>open<b>music</b></span></span>
}

export function Sleeve({className}: {className:string}) {
  return <svg className={className} viewBox="0 0 160 134" fill="none" aria-hidden="true">
    <rect x="1" y="1" width="158" height="132" fill="var(--color-raised)"/>
    <circle cx="102" cy="67" r="54" fill="var(--record)"/>
    {[48,44,39,34,30,26].map(r=><circle key={r} cx="102" cy="67" r={r} stroke="#525252" strokeWidth=".9"/>)}
    <circle cx="102" cy="67" r="18" fill="var(--label-blue)"/><circle cx="102" cy="67" r="3" fill="var(--color-raised)"/>
    <path d="M8 16h73v102H8z" fill="var(--label-blue)"/>
    <path d="M17 29h54m-54 5h38m-38 62h9v11h-9zm13 0h9v11h-9z" stroke="white" strokeWidth="2"/>
  </svg>
}
