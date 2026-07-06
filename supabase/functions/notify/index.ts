// Supabase Edge Function (Deno) — triggered by a Database Webhook on
// `messages` INSERT. Sends an Expo push notification to every other member
// of the conversation.
//
// Deploy: supabase functions deploy notify
// Secrets: supabase secrets set WEBHOOK_SECRET=<random-value>
//   (SUPABASE_URL and SUPABASE_SECRET_KEYS are injected automatically —
//   no need to set those yourself.)
// Wire up: Supabase Dashboard → Database → Webhooks → messages → INSERT →
//   URL = this function's URL, header `x-webhook-secret: <same random value>`.
// This function has verify_jwt disabled in supabase/config.toml since the
// webhook authenticates via the custom header above, not a Supabase JWT.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const WEBHOOK_SECRET = Deno.env.get('WEBHOOK_SECRET')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
// The secret key (sb_secret_...) replaces the legacy service_role key — it
// still bypasses RLS, so it must only ever live in this server-side
// function's environment, never in the client bundle (security-hardening #5).
// Edge Functions auto-inject it as a JSON map keyed by key name.
const SECRET_KEY = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default as
  | string
  | undefined
if (!SECRET_KEY) throw new Error('SUPABASE_SECRET_KEYS not available in this environment')

Deno.serve(async (req) => {
  // Reject anything without the shared secret — otherwise anyone who learns
  // the function URL can trigger arbitrary push spam (security-hardening #8).
  if (req.headers.get('x-webhook-secret') !== WEBHOOK_SECRET) {
    return new Response('unauthorized', { status: 401 })
  }

  const body = await req.json()
  const record = body.record as {
    id: string
    conversation_id: string
    sender_id: string
    content: string
  }

  if (!record?.conversation_id || !record?.sender_id) {
    return new Response('bad request', { status: 400 })
  }

  const admin = createClient(SUPABASE_URL, SECRET_KEY)

  const { data: members } = await admin
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', record.conversation_id)
    .neq('user_id', record.sender_id)

  const allRecipientIds = (members ?? []).map((m) => m.user_id)
  if (allRecipientIds.length === 0) return new Response('ok')

  // Skip anyone who already has this exact conversation open and
  // foregrounded — see app/(app)/chat/[id].tsx for how active_conversation_id
  // gets set/cleared. They're already seeing the message live via realtime,
  // so a push here would just be noise (sound/vibration for a chat they're
  // actively looking at).
  const { data: activeViewers } = await admin
    .from('profiles')
    .select('id')
    .in('id', allRecipientIds)
    .eq('active_conversation_id', record.conversation_id)

  const activeViewerIds = new Set((activeViewers ?? []).map((p) => p.id))
  const recipientIds = allRecipientIds.filter((id) => !activeViewerIds.has(id))
  if (recipientIds.length === 0) return new Response('ok')

  const { data: devices } = await admin
    .from('user_devices')
    .select('expo_push_token')
    .in('user_id', recipientIds)

  const tokens = [...new Set((devices ?? []).map((d) => d.expo_push_token))]
  if (tokens.length === 0) return new Response('ok')

  const { data: sender } = await admin
    .from('profiles')
    .select('username')
    .eq('id', record.sender_id)
    .single()

  // Treat `record.content` and the sender's username as untrusted input —
  // they're only ever placed in the notification title/body, never
  // interpolated into anything executable.
  const pushResponse = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      tokens.map((to) => ({
        to,
        sound: 'default',
        title: sender?.username ?? 'New message',
        body: record.content,
        data: { conversationId: record.conversation_id },
        // Must match the Android notification channel created in
        // hooks/usePushToken.ts — without it, Android routes the
        // notification through an auto-created channel with no sound or
        // vibration, regardless of the "sound" field above.
        channelId: 'messages',
      }))
    ),
  })

  // Expo's push API can return 200 with a per-message error in the body
  // (e.g. bad/expired token, FCM credential problems) — logging it here is
  // the only way to see that class of failure, since a 200 from this
  // function otherwise says nothing about whether the push was actually
  // accepted downstream. See documentation.md §6.14 for a case where this
  // silently masked a credential misconfiguration for a while.
  const pushResult = await pushResponse.json().catch(() => null)
  const hasError = pushResult?.data?.some((r: { status?: string }) => r.status === 'error')
  if (hasError) console.error('Expo push API reported an error:', JSON.stringify(pushResult))

  return new Response('ok')
})
