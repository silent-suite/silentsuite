import Hero from './sections/Hero'
import Showcase from './sections/Showcase'
import Problem from './sections/Problem'
import WhoCanRead from './sections/WhoCanRead'
import Features from './sections/Features'
import BridgeSpotlight from './sections/BridgeSpotlight'
import Security from './sections/Security'
import Pricing from './sections/Pricing'
import SyncEverywhere from './sections/SyncEverywhere'
import Waitlist from './sections/Waitlist'
import FAQ from './sections/FAQ'
import Footer from './sections/Footer'

export default function Home() {
  return (
    <main>
      <Hero />
      <Showcase />
      <Problem />
      <WhoCanRead />
      <Features />
      <BridgeSpotlight />
      <Security />
      <Pricing />
      <SyncEverywhere />
      <Waitlist />
      <FAQ />
      <Footer />
    </main>
  )
}
