// SEO helpers — React 19 native metadata hoisting (no react-helmet-async needed)
export const defaultSEO = {
  title: "BijliSathi — Kanpur Power Grid | Report & Track Electricity Faults Live",
  description: "Report power cuts in 30 seconds, watch your technician live on map. BijliSathi connects Kanpur citizens, KESCO linemen & control room with AI triage.",
  keywords: "KESCO, Kanpur electricity, power cut complaint, BijliSathi, outage tracker, KESCO complaint",
  image: "/logo.png",
  url: "https://bijlisathi.vercel.app",
  type: "website",
}

// Use in any screen: <SEO title="Track Complaint — BijliSathi" description="..." />
// React 19 hoists <title> and <meta> tags to <head> automatically.
