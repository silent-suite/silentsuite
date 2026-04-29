import Hero from './sections/Hero'
import Showcase from './sections/Showcase'
import Problem from './sections/Problem'
import Features from './sections/Features'
import Security from './sections/Security'
import Pricing from './sections/Pricing'
import Waitlist from './sections/Waitlist'
import FAQ from './sections/FAQ'
import Footer from './sections/Footer'

export default function Home() {
  return (
    <main>
      <Hero />
      <Showcase />
      <Problem />
      <Features />
      <Security />
      <Pricing />
      <Waitlist />
      <FAQ />
      <Footer />
    </main>
  )
}
