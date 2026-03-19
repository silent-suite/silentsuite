import { NextRequest, NextResponse } from 'next/server'

const FB_ENV_ID = process.env.FORMBRICKS_ENV_ID || ''
const FB_SURVEY_ID = process.env.FORMBRICKS_SURVEY_ID || ''

export async function POST(req: NextRequest) {
  try {
    const { email, name, useCase } = await req.json()

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    const res = await fetch(
      `https://app.formbricks.com/api/v1/client/${FB_ENV_ID}/responses`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          surveyId: FB_SURVEY_ID,
          finished: true,
          data: {
            email,
            ...(name && { name }),
            ...(useCase && { usecase: useCase }),
            confirmed: 'no',
          },
        }),
      }
    )

    if (!res.ok) {
      const body = await res.text()
      console.error('Formbricks error:', body)
      return NextResponse.json({ error: 'Submission failed' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Waitlist API error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
