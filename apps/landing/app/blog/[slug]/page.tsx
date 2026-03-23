import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Calendar, ArrowLeft, Clock } from 'lucide-react'
import { getPost, getAllPosts } from '../posts'

// Blog post content components -- one per slug
import WhyWeAreBuildingSilentSuite from '../content/why-we-are-building-silentsuite'
import WhoCanReadYourCalendar from '../content/who-can-read-your-calendar'
import SilentSuiteVsGoogleCalendar from '../content/silentsuite-vs-google-calendar'
// import EncryptedCalendarSync2026ComparingOptions from '../content/encrypted-calendar-sync-2026-comparing-options'
// import SelfHostingVsHostedPrivateCalendar from '../content/self-hosting-vs-hosted-private-calendar'

const contentMap: Record<string, React.ComponentType> = {
  'why-we-are-building-silentsuite': WhyWeAreBuildingSilentSuite,
  'who-can-read-your-calendar': WhoCanReadYourCalendar,
  'silentsuite-vs-google-calendar': SilentSuiteVsGoogleCalendar,
  // 'encrypted-calendar-sync-2026-comparing-options': EncryptedCalendarSync2026ComparingOptions,
  // 'self-hosting-vs-hosted-private-calendar': SelfHostingVsHostedPrivateCalendar,
}

// Generate static params for all blog posts
export function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }))
}

// Dynamic metadata per post
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const post = getPost(slug)
  if (!post) return { title: 'Post Not Found — SilentSuite' }

  return {
    title: `${post.title} — SilentSuite Blog`,
    description: post.description,
    openGraph: {
      title: post.title,
      description: post.description,
      type: 'article',
      publishedTime: post.date,
      authors: [post.author],
      tags: post.tags,
      ...(post.coverImage ? { images: [post.coverImage] } : {}),
    },
  }
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export default async function BlogPost({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const post = getPost(slug)
  if (!post) notFound()

  const Content = contentMap[slug]
  if (!Content) notFound()

  return (
    <main className="min-h-screen bg-navy-950 text-white pt-16">
      {/* Hero cover */}
      <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 pt-8">
        <div className="relative w-full rounded-2xl overflow-hidden border border-navy-700/50" style={{ aspectRatio: '16/9' }}>
          {/* Cover image */}
          {post.coverImage ? (
            <Image
              src={post.coverImage}
              alt={post.title}
              fill
              className="object-cover opacity-60"
              priority
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-navy-900 to-navy-950" />
          )}

          {/* Dark overlay */}
          <div className="absolute inset-0 bg-black/30" />

          {/* Content overlay */}
          <div className="relative z-10 flex flex-col items-center justify-center h-full px-6 sm:px-12 py-10 text-center">
            {/* Tags */}
            <div className="flex gap-2 mb-6">
              {post.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs px-3 py-1 rounded-full text-navy-300/70 bg-white/5 backdrop-blur-sm"
                >
                  {tag}
                </span>
              ))}
            </div>

            {/* Title */}
            <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold leading-tight max-w-3xl">
              {post.title}
            </h1>

            {/* Author + date */}
            <div className="mt-6 flex items-center gap-4 text-sm text-navy-300">
              <span className="font-medium text-white">{post.author}</span>
              <span className="text-navy-500">&middot;</span>
              <div className="flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5" />
                <time dateTime={post.date}>{formatDate(post.date)}</time>
              </div>
              <span className="text-navy-500">&middot;</span>
              <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                <span>{post.readingTime}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Article */}
      <article className="max-w-3xl mx-auto px-6 py-12">
        {/* Description / lede */}
        <p className="text-xl text-navy-300 mb-12 leading-relaxed">
          {post.description}
        </p>

        {/* Article body */}
        <div className="prose prose-invert max-w-none text-navy-200 leading-relaxed
          [&_h2]:text-2xl [&_h2]:font-bold [&_h2]:text-white [&_h2]:mt-12 [&_h2]:mb-4
          [&_h3]:text-xl [&_h3]:font-semibold [&_h3]:text-white [&_h3]:mt-8 [&_h3]:mb-3
          [&_p]:mb-4 [&_p]:leading-relaxed
          [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:mb-4 [&_ul]:space-y-2
          [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:mb-4 [&_ol]:space-y-2
          [&_li]:text-navy-200
          [&_a]:text-teal-400 [&_a]:underline [&_a]:hover:text-teal-300
          [&_strong]:text-white [&_strong]:font-semibold
          [&_blockquote]:border-l-2 [&_blockquote]:border-teal-400/40 [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-navy-300 [&_blockquote]:my-6
          [&_hr]:border-navy-700 [&_hr]:my-10
        ">
          <Content />
        </div>

        {/* CTA */}
        <div className="mt-16 p-8 rounded-xl border border-navy-700 bg-navy-900/50 text-center">
          <h2 className="text-2xl font-bold mb-3">
            Interested in private sync?
          </h2>
          <p className="text-navy-300 mb-6">
            SilentSuite is available now. Sign up and start syncing your
            calendar, contacts, and tasks with end-to-end encryption.
          </p>
          <a
            href="https://app.silentsuite.io/signup"
            className="inline-block px-8 py-3 bg-teal-400 hover:bg-teal-500 text-navy-950 font-semibold rounded-lg transition-colors"
          >
            Get Started
          </a>
        </div>

        {/* Back link */}
        <div className="mt-12 pt-8 border-t border-navy-700">
          <Link
            href="/blog"
            className="text-teal-400 hover:underline text-sm flex items-center gap-1"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to all posts
          </Link>
        </div>
      </article>
    </main>
  )
}
