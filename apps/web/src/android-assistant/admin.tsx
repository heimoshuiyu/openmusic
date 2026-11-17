import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { AdminPage } from "@/pages/admin"
import { connect, tell } from "./bridge"
import "@/index.css"
import "@/components/catalog.css"

connect(() => {
  // The page remains mounted while the Console device-authorization browser is open.
  // No credentials, form state, or React Query data is persisted in WebView storage.
  const queries = new QueryClient({ defaultOptions: { queries: {retry: false} } })
  document.addEventListener("click", event => {
    const link = (event.target as Element)?.closest?.("a")
    if (!link) return
    event.preventDefault()
    const href = link.getAttribute("href") ?? ""
    if (href.startsWith("#")) document.getElementById(href.slice(1))?.scrollIntoView()
    else if (event.isTrusted) tell("link", {href})
  })
  createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queries}><AdminPage/></QueryClientProvider>)
}, "openmusic-admin")
