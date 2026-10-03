import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { Web3Provider } from '@/contexts/Web3Provider';
import { AffiliateProvider } from '@/contexts/AffiliateContext';
import { CartProvider } from '@/contexts/CartContext';
import { PurchaseModalProvider } from '@/contexts/PurchaseModalContext';
import { CustomerProvider } from '@/contexts/CustomerContext';
import { ToastProvider } from '@/contexts/ToastContext';
import { SiteConfigProvider } from '@/contexts/SiteConfigContext';
import { PromosProvider } from '@/contexts/PromosContext';
import ChatBubble from '@/components/ChatBubble';
import FreeShippingToast from '@/components/FreeShippingToast';
import AgeVerification from '@/components/AgeVerification';
import AuthGuard from '@/components/AuthGuard';
import ChunkErrorRecovery from '@/components/ChunkErrorRecovery';
import AnnouncementBar from '@/components/AnnouncementBar';
import SiteTracking from '@/components/SiteTracking';
import CustomerJourneyTracker from '@/components/CustomerJourneyTracker';
import { siteConfig } from '@/lib/config';
import { getServerSiteConfig } from '@/lib/site-config-server';
import { consentDefaultSnippet } from '@/lib/analytics/consent';

/**
 * VYTA pairs "Inter Display" (headings / product names / campaigns) with
 * "Inter" (body copy, UI, specifications, long-form). Inter v4 is a single
 * variable family carrying an optical-size axis, so both cuts come from one
 * download: body text uses the default optical size, and `.font-display`
 * (globals.css) pins `opsz` to 32 for the display cut.
 */
const inter = Inter({
  subsets: ['latin'],
  axes: ['opsz'],
  variable: '--font-inter',
  display: 'swap',
});

// Branding-aware metadata. Reads the site_settings singleton for the store
// name / tagline / favicon, wrapped so a missing client or un-migrated DB
// falls back to the historical defaults (never breaks the build/page).
export async function generateMetadata(): Promise<Metadata> {
  const cfg = await getServerSiteConfig();
  return {
    title: `${cfg.store_name} - ${cfg.store_tagline}`,
    description:
      'Your trusted source for high-quality peptides in Canada. Fast Canada-wide shipping, secure payment options including cryptocurrency.',
    keywords: 'peptides, research peptides, BPC-157, TB-500, laboratory peptides',
    icons: {
      icon: cfg.favicon_url || '/favicon.png',
    },
    // Google Search Console ownership proof. Rendered into <head> on every
    // page as <meta name="google-site-verification" ...>, which is what the
    // "HTML tag" verification method checks for — it only ever reads the
    // homepage, but leaving it site-wide keeps verification from lapsing.
    verification: {
      google: 'o9_eT_n204rgAFQoJuAGpgIlh3XcKjMDtHZ4oKfpb6w',
    },
  };
}

const KLAVIYO_INIT_SNIPPET = `!function(){if(!window.klaviyo){window._klOnsite=window._klOnsite||[];try{window.klaviyo=new Proxy({},{get:function(n,i){return"push"===i?function(){var n;(n=window._klOnsite).push.apply(n,arguments)}:function(){for(var n=arguments.length,o=new Array(n),w=0;w<n;w++)o[w]=arguments[w];var t="function"==typeof o[o.length-1]?o.pop():void 0,e=new Promise((function(n){window._klOnsite.push([i].concat(o,[function(i){t&&t(i),n(i)}]))}));return e}}})}catch(n){window.klaviyo=window.klaviyo||[],window.klaviyo.push=function(){var n;(n=window._klOnsite).push.apply(n,arguments)}}}}();`;

// Whop Pixel, verbatim from Whop's install snippet (business biz_4uByt2hc4AZpRx).
// Do not edit: it must match the snippet character-for-character.
const WHOP_PIXEL_SNIPPET = `!function(w,d,s,u,n,a,b){if(w[n])return;a=w[n]={q:[],t:+new Date,s:[],o:u,track:function(){a.q.push([+new Date].concat([].slice.call(arguments)))},setScope:function(){a.s=[].slice.call(arguments).filter(function(x){return typeof x==="string"});a.q.push([+new Date,"setScope"].concat(a.s))},scope:function(){var c=[].slice.call(arguments);return{track:function(){a.q.push([+new Date].concat([].slice.call(arguments)).concat([{__scope:c}]))}}}};b=d.createElement(s);b.async=1;b.src=u+"/s.js";d.getElementsByTagName(s)[0].parentNode.insertBefore(b,d.getElementsByTagName(s)[0])}(window,document,"script","https://t.whop.tw","whop");whop.setScope("biz_4uByt2hc4AZpRx");whop.track("page");`;

function MaybeWeb3Provider({ children }: { children: React.ReactNode }) {
  if (!siteConfig.cryptoPaymentsEnabled) return <>{children}</>;
  return <Web3Provider>{children}</Web3Provider>;
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const {
    gtm_container_id: gtmId,
    ga4_measurement_id: ga4Id,
    tracking_consent_required: consentRequired,
    klaviyo_public_key: klaviyoId,
  } = await getServerSiteConfig();

  // Google Tag Manager, installed exactly as the container snippet specifies:
  // the script as high in <head> as possible and the <noscript> iframe
  // immediately after <body>, both server-rendered and unconditional. Loading
  // the container is what makes it detectable by Tag Assistant / GTM Preview,
  // so it is deliberately NOT behind the cookie banner — consent is enforced
  // one level down, by the Consent Mode signals set just above it, which is
  // what the tags inside the container read.
  const gtmSnippet = gtmId
    ? `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${gtmId}');`
    : null;

  return (
    <html lang="en">
      <head>
        {/* Consent Mode defaults — must execute before gtag.js / gtm.js below,
            or tags fire once in an unknown state before the first signal
            arrives. Applies to both: gtag and the container read the same
            signals. */}
        {(gtmSnippet || ga4Id) && (
          <script
            dangerouslySetInnerHTML={{ __html: consentDefaultSnippet(consentRequired) }}
          />
        )}
        {/* Google tag (gtag.js) — GA4 loads DIRECTLY here rather than as a tag
            inside GTM, so it is detected as installed by Tag Assistant on its
            own. Do not also add a GA4 configuration tag to the container: two
            GA4 tags on one page double every hit. */}
        {ga4Id && (
          <>
            <script async src={`https://www.googletagmanager.com/gtag/js?id=${ga4Id}`} />
            <script
              dangerouslySetInnerHTML={{
                __html: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}
window.gtag=window.gtag||gtag;gtag('js',new Date());gtag('config','${ga4Id}');`,
              }}
            />
          </>
        )}
        {/* Klaviyo object initializer, from Klaviyo's install snippet. It
            only defines window.klaviyo as a queue onto window._klOnsite — no
            network or cookies — so calls made before klaviyo.js arrives are
            replayed once it does. klaviyo.js itself is loaded by SiteTracking,
            and only after the visitor accepts the cookie banner. */}
        {klaviyoId && <script dangerouslySetInnerHTML={{ __html: KLAVIYO_INIT_SNIPPET }} />}
        {/* Google Tag Manager */}
        {gtmSnippet && <script dangerouslySetInnerHTML={{ __html: gtmSnippet }} />}
        {/* End Google Tag Manager */}
        {/* Whop Pixel */}
        <script dangerouslySetInnerHTML={{ __html: WHOP_PIXEL_SNIPPET }} />
      </head>
      <body className={`${inter.variable} ${inter.className}`}>
        {/* Google Tag Manager (noscript) */}
        {gtmId && (
          <noscript>
            <iframe
              src={`https://www.googletagmanager.com/ns.html?id=${gtmId}`}
              height="0"
              width="0"
              style={{ display: 'none', visibility: 'hidden' }}
            />
          </noscript>
        )}
        {/* End Google Tag Manager (noscript) */}
        <MaybeWeb3Provider>
          <LanguageProvider>
            <SiteConfigProvider>
              <AffiliateProvider>
                <CustomerProvider>
                  <CartProvider>
                    {/* Inside CustomerProvider and CartProvider: which promos a
                        visitor gets depends on whether they are signed in, and
                        what they are told about them depends on their cart. */}
                    <PromosProvider>
                      <ToastProvider>
                        <PurchaseModalProvider>
                          <AuthGuard>
                            <ChunkErrorRecovery />
                            {/* Sticky site-wide banner. Renders before the
                                page so its in-flow spacer pushes everything
                                down by exactly the bar's height; it hides
                                itself on the admin / warehouse / affiliate
                                portals. */}
                            <AnnouncementBar />
                            {children}
                            <ChatBubble />
                            <FreeShippingToast />
                            <AgeVerification />
                            <SiteTracking />
                            <CustomerJourneyTracker />
                          </AuthGuard>
                        </PurchaseModalProvider>
                      </ToastProvider>
                    </PromosProvider>
                  </CartProvider>
                </CustomerProvider>
              </AffiliateProvider>
            </SiteConfigProvider>
          </LanguageProvider>
        </MaybeWeb3Provider>
      </body>
    </html>
  );
}
