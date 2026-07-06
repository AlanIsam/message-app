export type Profile = {
  id: string
  username: string
  avatar_url: string | null
}

export type Message = {
  id: string
  conversation_id: string
  sender_id: string
  content: string
  created_at: string
}

// Shape returned by the get_conversations() RPC — see supabase/schema.sql.
export type Conversation = {
  id: string
  name: string | null
  is_group: boolean
  last_message: string | null
  last_message_at: string | null
  other_user_id: string | null
  other_username: string | null
  unread_count: number
}
