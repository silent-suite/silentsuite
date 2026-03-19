import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { ArrowRight, Calendar, Rss } from 'lucide-react'
import { getAllPosts } from './posts'

export const metadata: Metadata = {
  title: 'Blog — SilentSuite',
  description:
    'Thoughts on privacy, encryption, and building tools that respect your data.',
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export default function BlogIndex() {
  const posts = getAllPosts()

  return (
    <main className="min-h-screen bg-navy-950 text-white pt-16">
      {/* Content */}
      <div className="max-w-4xl mx-auto px-6 py-16">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-4xl font-bold">Blog</h1>
          <a
            href="/blog/feed.xml"
            className="flex items-center gap-1.5 text-sm text-navy-400 hover:text-teal-400 transition-colors"
            title="RSS Feed"
          >
            <Rss className="w-4 h-4" />
            <span>RSS</span>
          </a>
        </div>
        <p className="text-navy-400 mb-12 text-lg">
          Thoughts on privacy, encryption, and why your personal data deserves
          better.
        </p>

        {/* Post list */}
        <div className="space-y-8">
          {posts.map((post) => (
            <Link
              key={post.slug}
              href={`/blog/${post.slug}`}
              className="group block rounded-2xl overflow-hidden border border-navy-700 hover:border-teal-400/30 transition-all"
            >
              {/* Cover image */}
              {post.coverImage && (
                <div className="relative w-full overflow-hidden" style={{ aspectRatio: '16/7' }}>
                  <Image
                    src={post.coverImage}
                    alt={post.title}
                    fill
                    className="object-cover opacity-60 group-hover:opacity-70 transition-opacity"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-navy-950 via-navy-950/60 to-transparent" />
                  <div className="absolute bottom-0 left-0 right-0 p-6 sm:p-8">
                    <div className="flex gap-2 mb-3">
                      {post.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-xs px-2.5 py-1 rounded-full border border-navy-600 text-teal-400 bg-navy-800/60"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                    <h2 className="text-2xl sm:text-3xl font-bold text-white group-hover:text-teal-400 transition-colors leading-tight">
                      {post.title}
                    </h2>
                  </div>
                </div>
              )}

              {/* Card body */}
              <div className="p-6 bg-navy-900/30">
                {/* Show title here if no cover image */}
                {!post.coverImage && (
                  <h2 className="text-xl font-semibold mb-2 group-hover:text-teal-400 transition-colors">
                    {post.title}
                  </h2>
                )}

                <p className="text-navy-300 mb-4 leading-relaxed">
                  {post.description}
                </p>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 text-sm text-navy-400">
                    <span className="font-medium text-navy-300">{post.author}</span>
                    <span>&middot;</span>
                    <div className="flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5" />
                      <time dateTime={post.date}>{formatDate(post.date)}</time>
                    </div>
                    <span>&middot;</span>
                    <span>{post.readingTime}</span>
                  </div>
                  <span className="text-teal-400 text-sm flex items-center gap-1 group-hover:underline">
                    Read <ArrowRight className="w-3.5 h-3.5" />
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </main>
  )
}
