# Phase 4 — Groups (Create & Manage)

## Goal
Users can create a group conversation, name it, add multiple members, and chat in it.
Groups reuse the same `conversations` / `messages` infrastructure already built — the only
difference is `is_group = true` and `name` is set.

---

## Prerequisites
Phases 1–3 complete. The schema already supports groups (see `overview.md`):
- `conversations.is_group` boolean
- `conversations.name` text
- `conversation_members` join table

No schema changes needed. No new packages needed.

---

## What to Build

### `components/CreateGroupModal.tsx`
A modal (use React Native's `Modal` component) for creating a group.

State inside the modal:
- `groupName: string`
- `selectedUserIds: Set<string>`
- `allUsers: Profile[]` — fetched list of users to pick from

```ts
type Props = {
  visible: boolean
  onClose: () => void
  onCreated: (conversationId: string) => void
}
```

On mount (or when opened): fetch all profiles except the current user:
```ts
const { data } = await supabase
  .from('profiles')
  .select('id, username, avatar_url')
  .neq('id', currentUser.id)
```

UI layout:
- Text input for the group name
- A `FlatList` of users, each row tappable to toggle selection (checkmark when selected)
- "Create" button — disabled until name is non-empty AND at least 1 user selected
- "Cancel" button

---

### Group Creation Logic
Creating a group touches two tables. Do it in sequence:

```ts
async function createGroup(name: string, memberIds: string[]) {
  // 1. Create the conversation
  const { data: convo, error } = await supabase
    .from('conversations')
    .insert({ name, is_group: true, created_by: currentUser.id })
    .select()
    .single()

  if (error) throw error

  // 2. Add members — include the creator
  const members = [currentUser.id, ...memberIds].map((userId) => ({
    conversation_id: convo.id,
    user_id: userId,
  }))

  const { error: memberError } = await supabase
    .from('conversation_members')
    .insert(members)

  if (memberError) throw memberError

  return convo.id
}
```

**RLS gotcha:** The `conversation_members` insert policy from `overview.md` allows any
authenticated user to insert. For a non-robust app this is fine. If you later want to lock it
down so only the creator can add members, you'd write a stricter policy or move this into a
Postgres function / Edge Function that runs with elevated privileges.

After creation: call `onCreated(convo.id)` then navigate to `/(app)/chat/[id]`.

---

### Update `app/(app)/index.tsx` (Conversation List)
- Wire the floating `+` button (added in Phase 1) to open `CreateGroupModal`
- Optionally give the user a choice: "New Group" vs "New DM". For now, default the `+` to
  open the group modal. A DM is just a group with `is_group = false` and exactly 2 members —
  you can reuse the same flow with a single selected user if you want.
- After a group is created and the user navigates in, the conversation list should show the
  new group when they return (it will, since Phase 1 fetches all memberships).

---

### Update `app/(app)/chat/[id].tsx`
For group conversations:
- Show the group `name` in the header (instead of the other user's username)
- Above each message from others, show the sender's username (already handled by
  `MessageBubble` from Phase 1 — just make sure it's shown for groups, not just hidden)
- Optional: a header button to view the member list

---

### `components/GroupMembersList.tsx` (optional, nice-to-have)
A simple screen or modal listing members of a group with their online badges (reusing
`OnlineBadge` from Phase 3).

```ts
const { data } = await supabase
  .from('conversation_members')
  .select('user_id, profiles(username, avatar_url)')
  .eq('conversation_id', conversationId)
```

---

## Realtime Note
Group messages already work in realtime — the Phase 2 `useMessages` hook filters by
`conversation_id`, which works identically for groups and DMs. No changes needed.

---

## Out of Scope for This Phase
- Leaving a group / removing members
- Group avatars / images
- Admin roles and permissions
- Renaming a group after creation
- Invite links

(These are all straightforward extensions later — leaving/removing is just a delete from
`conversation_members`.)

---

## Done When
- [ ] User can open the create-group modal from the conversation list
- [ ] User can name the group and select multiple members
- [ ] "Create" is disabled until name + at least one member are set
- [ ] Creating a group navigates the user into the new group chat
- [ ] All added members see the group in their conversation list
- [ ] Messages in the group are delivered in realtime to all members
- [ ] Sender usernames are visible on messages in group chats
