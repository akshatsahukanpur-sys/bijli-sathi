import { defaultSEO } from "../lib/seo"

/**
 * SEO — Drop into any screen for perfect SEO (React 19 native).
 * Example: <SEO title="Report Issue — BijliSathi" description="..." url="https://..." />
 * All props are optional — falls back to defaultSEO.
 * React 19 natively hoists <title> and <meta> to <head>, so no Helmet needed.
 */
export default function SEO({ title, description, keywords, image, url, type }) {
  const seo = {
    title: title || defaultSEO.title,
    description: description || defaultSEO.description,
    keywords: keywords || defaultSEO.keywords,
    image: image || defaultSEO.image,
    url: url || defaultSEO.url,
    type: type || defaultSEO.type,
  }
  return (
    <>
      <title>{seo.title}</title>
      <meta name="description" content={seo.description} />
      <meta name="keywords" content={seo.keywords} />
      <meta property="og:title" content={seo.title} />
      <meta property="og:description" content={seo.description} />
      <meta property="og:image" content={seo.image} />
      <meta property="og:url" content={seo.url} />
      <meta property="og:type" content={seo.type} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={seo.title} />
      <meta name="twitter:description" content={seo.description} />
      <meta name="twitter:image" content={seo.image} />
      <link rel="canonical" href={seo.url} />
    </>
  )
}
