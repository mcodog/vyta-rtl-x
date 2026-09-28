import Navigation from '@/components/Navigation';
import Hero from '@/components/Hero';
import BestSellers from '@/components/home/BestSellers';
import WhyChooseVyta from '@/components/home/WhyChooseVyta';
import CollectionBanner from '@/components/home/CollectionBanner';
import Testimonials from '@/components/home/Testimonials';
import ServicePromises from '@/components/home/ServicePromises';
import Footer from '@/components/Footer';

/**
 * The storefront home page, in the order the design lays it out: what we sell,
 * what sells most, why us, where to start, and what other customers said.
 *
 * The "We Show Our Work" band (`components/home/ShowOurWork`) is hidden for
 * now; re-add it after `<BestSellers />` to bring it back.
 *
 * The "Shop by Wellness Focus" tiles (`components/home/WellnessFocus`) are
 * hidden too; see docs/wellness-focus-restore.md to bring them back.
 *
 * `Testimonials` renders nothing until a quote is written in Admin →
 * Testimonials, so the page reads correctly on a brand-new store too.
 */
export default function Home() {
  return (
    <main className="min-h-screen">
      <Navigation />
      <Hero />
      <BestSellers />
      <WhyChooseVyta />
      <CollectionBanner />
      <Testimonials />
      <ServicePromises />
      <Footer />
    </main>
  );
}
