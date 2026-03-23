import { NextRequest, NextResponse } from 'next/server'

const { Resend } = require("resend")
const resend = new Resend(process.env.RESEND_API_KEY)

export async function POST(req: NextRequest) {
  try {
    const { email, name } = await req.json()

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    const firstName = name ? name.split(' ')[0] : ''
    const greeting = firstName ? `Hi ${firstName},` : 'Hi there,'

    await resend.emails.send({
      from: 'SilentSuite <noreply@silentsuite.io>',
      to: email,
      subject: 'Welcome to SilentSuite updates',
      html: `
        <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
          <h2>${greeting}</h2>
          <p>Thanks for subscribing to SilentSuite updates.</p>
          <p>
            SilentSuite is an end-to-end encrypted calendar, contacts, and tasks
            sync service. Your data is encrypted on your device before it ever
            leaves. Not even we can read it.
          </p>
          <p>Here is what you get:</p>
          <ul>
            <li>Calendar, contacts, and tasks sync across all your devices</li>
            <li>End-to-end encryption with zero-knowledge architecture</li>
            <li>Web app, Android app, and CalDAV bridge</li>
            <li>Open-source server you can self-host</li>
          </ul>
          <p>
            Ready to try it?
            <a href="https://app.silentsuite.io/signup">Create your account</a>
            and get started.
          </p>
          <p>
            We will send you occasional product updates and feature announcements.
            No spam, ever.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;" />
          <p style="font-size: 12px; color: #888;">
            You received this email because you subscribed on silentsuite.io.
            To unsubscribe, reply to this email with "unsubscribe" or email
            <a href="mailto:info@silentsuite.io">info@silentsuite.io</a>.
          </p>
        </div>
      `,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Newsletter API error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
