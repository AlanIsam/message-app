# Chat App — Project Overview

## What We're Building
A Discord-like chat app with:
- Online presence detection
- Sound on message received
- Group conversations
- Real-time messaging
- Available on **Android + Web** from a single codebase

---

## Tech Stack

| Layer | Tool | Why |
|---|---|---|
| Mobile + Web | **Expo (React Native)** | One codebase, targets Android + Web |
| Routing | **expo-router** | File-based routing, similar to Next.js App Router |
| Backend | **Supabase** | Realtime, Presence, Auth, PostgreSQL — all in one |
| Sound | **expo-av** | Simple audio playback in Expo |
| Push Notifications | **expo-notifications + FCM** | Android background notifications |
| Language | **TypeScript** | Type safety across the whole app |

---

## Database Schema (Supabase / PostgreSQL)

```sql
-- User profiles (extends Supabase auth)
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  username text unique not null,
  avatar_url text,
  created_at timestamptz default now()
);

-- Conversations — supports both DMs and groups
create table public.conversations (
  id uuid default gen_random_uuid() primary key,
  name text,                  -- null for DMs, set for groups
  is_group boolean default false,
  created_by uuid references public.profiles(id),
  created_at timestamptz default now()
);

-- Who belongs to each conversation
create table public.conversation_members (
  conversation_id uuid references public.conversations(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  joined_at timestamptz default now(),
  primary key (conversation_id, user_id)
);

-- Messages
create table public.messages (
  id uuid default gen_random_uuid() primary key,
  conversation_id uuid references public.conversations(id) on delete cascade,
  sender_id uuid references public.profiles(id),
  content text not null,
  created_at timestamptz default now()
);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, username)
  values (new.id, new.raw_user_meta_data->>'username');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
```

### Row Level Security (RLS) — enable on all tables

```sql
-- Profiles: anyone authenticated can read, only owner can update
alter table public.profiles enable row level security;
create policy "Profiles are viewable by authenticated users"
  on public.profiles for select using (auth.role() = 'authenticated');
create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id);

-- Conversations: only members can view
alter table public.conversations enable row level security;
create policy "Members can view their conversations"
  on public.conversations for select using (
    exists (
      select 1 from public.conversation_members
      where conversation_id = id and user_id = auth.uid()
    )
  );
create policy "Authenticated users can create conversations"
  on public.conversations for insert with check (auth.role() = 'authenticated');

-- Conversation members: only members can view
alter table public.conversation_members enable row level security;
create policy "Members can view membership"
  on public.conversation_members for select using (
    user_id = auth.uid() or
    exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = conversation_id and cm.user_id = auth.uid()
    )
  );
create policy "Members can be added by conversation creator"
  on public.conversation_members for insert with check (auth.role() = 'authenticated');

-- Messages: only conversation members can read/insert
alter table public.messages enable row level security;
create policy "Members can view messages"
  on public.messages for select using (
    exists (
      select 1 from public.conversation_members
      where conversation_id = messages.conversation_id and user_id = auth.uid()
    )
  );
create policy "Members can send messages"
  on public.messages for insert with check (
    exists (
      select 1 from public.conversation_members
      where conversation_id = messages.conversation_id and user_id = auth.uid()
    )
  );
```

---

## Project File Structure

```
chat-app/
├── app/
│   ├── _layout.tsx              # Root layout, auth gate
│   ├── (auth)/
│   │   ├── _layout.tsx
│   │   ├── login.tsx
│   │   └── register.tsx
│   └── (app)/
│       ├── _layout.tsx          # Tab or stack layout for main app
│       ├── index.tsx            # Conversation list
│       └── chat/
│           └── [id].tsx         # Chat screen (dynamic route)
├── components/
│   ├── MessageBubble.tsx
│   ├── MessageInput.tsx
│   ├── ConversationItem.tsx
│   ├── OnlineBadge.tsx          # Phase 3
│   └── CreateGroupModal.tsx     # Phase 4
├── hooks/
│   ├── useAuth.ts
│   ├── useMessages.ts           # Phase 2
│   └── usePresence.ts           # Phase 3
├── lib/
│   └── supabase.ts              # Supabase client singleton
├── constants/
│   └── colors.ts                # Theme colors
└── assets/
    └── sounds/
        └── message.mp3          # Phase 5
```

---

## Build Phases

| Phase | Focus | File |
|---|---|---|
| 1 | Auth + basic chat UI (no realtime) | `phase-1-auth-and-chat-ui.md` |
| 2 | Supabase Realtime for live messages | `phase-2-realtime-messages.md` |
| 3 | Presence — online detection | `phase-3-presence.md` |
| 4 | Groups — create and manage | `phase-4-groups.md` |
| 5 | Sound + Android push notifications | `phase-5-sound-and-notifications.md` |

Work through phases in order. Each phase assumes the previous is complete.

---

## Environment Variables

Create a `.env` file at project root:

```
EXPO_PUBLIC_SUPABASE_URL=your_supabase_project_url
EXPO_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

Get these from: Supabase Dashboard → Project Settings → API.
