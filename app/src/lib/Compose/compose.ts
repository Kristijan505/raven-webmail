import Compose from "./Compose.svelte";
import { mount, unmount } from "svelte";

export type Draft = {
  key: number
  id: number
  mailbox: string,
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  text: string
  html: string
  files: MessageFile[]
  // Attachments the ORIGINAL message carries into a forward. Not the same thing as
  // `files`, which is what the user attached here and lives in storage: these are parts
  // of the referenced message, and WildDuck copies them itself when it creates the
  // draft. Read off the original — never off the draft's own copies, whose ids belong
  // to the new message's mime tree and are not what WildDuck matches against.
  //
  // `null` means "we could not read the original", which is different from "there are
  // none": one has to fall back to letting WildDuck copy everything, the other has to
  // send an empty list. Keeping them distinct is what stops a failed lookup from
  // quietly dropping the attachments off a forward.
  carried?: Attachment[] | null
  reference?: Reference
  [kShowBcc]: boolean,
  [kShowCc]: boolean
  [kSent]?: boolean
}

export type MessageFile<T = string | void> = {
  id: T
  filename: string
  contentType: string
  size: number
  [fileError]?: string
  [fileFile]?: File
  [fileState]?: "error" | "uploading" | "complete"
  [fileLoaded]?: number
}

export const fileFile = Symbol("draft-file-file");
export const fileState = Symbol("draft-file-state");
export const fileError = Symbol("draft-file-error");
export const fileLoaded = Symbol("draft-file-loaded");

export type Reference = {
  mailbox: string
  id: number
  action: "reply" | "replyAll" | "forward"
  // true = copy all of the original's attachments, false = none, array = copy exactly
  // these ids. WildDuck matches an array against the ORIGINAL message's attachment ids
  // (`!options.reference.attachments.includes(attachment.id)` in its messages API), and
  // skips anything marked `related` in every case — embedded images travel with the
  // body, not as attachments.
  attachments: boolean | string[]
}

/**
 * The `attachments` directive to send for a draft, given what the user has left on it.
 *
 * WildDuck does NOT round-trip this: a GET on a saved draft returns `reference` as
 * {mailbox, id, action} only. Since save() is create-new + delete-old and send() saves
 * first, the message that actually goes out is always rebuilt from a reference read
 * back off the server — so whatever this returns is what decides, every time.
 *
 * Deriving it here rather than storing it on the draft keeps one rule in one place:
 * forward carries attachments, reply and replyAll do not, and a forward carries exactly
 * the ones still on the draft. An unknown carried list falls back to `true`, which is
 * what the directive meant before it could be narrowed — losing the lookup must not
 * also lose the attachments.
 */

/**
 * Which of the ORIGINAL message's attachments a forward draft still carries.
 *
 * The original supplies the ids — the only ones WildDuck matches a narrowed directive
 * against — and the draft's own copies supply the choice, since WildDuck rebuilt those
 * from the last directive it was given. The directive itself is not round-tripped, so
 * this intersection is the only surviving record of what the user removed.
 *
 * Copies carry ids from the new message's mime tree, so they are joined on content.
 * Two known hashes that differ settle it: they are different files, whatever their
 * names say. Filename and size stand in only where a hash is missing.
 *
 * Each surviving copy accounts for exactly ONE original. A message may carry the same
 * file twice, and asking merely whether SOME copy matches would let one survivor vouch
 * for both — restoring the row that was just removed.
 */
export const sameFile = (copy: Attachment, source: Attachment): boolean =>
  (copy.hash && source.hash)
    ? copy.hash === source.hash
    : copy.filename === source.filename && copy.sizeKb === source.sizeKb;

export const claimCarried = (original: Attachment[], onDraft: Attachment[]): Attachment[] => {
  const unclaimed = [...onDraft];
  return original
    .filter(item => !item.related)
    .filter(item => {
      const index = unclaimed.findIndex(copy => sameFile(copy, item));
      if(index === -1) return false;
      unclaimed.splice(index, 1);
      return true;
    });
}

export const referenceFor = (
  reference: Reference | void,
  carried: Attachment[] | null | undefined,
): Reference | void => {
  if(!reference) return reference;
  if(reference.action !== "forward") return { ...reference, attachments: false };
  return { ...reference, attachments: carried ? carried.map(item => item.id) : true };
}

export type Address = {
  name?: string
  address: string
};

export const baseDraft = {
  draft: true,
  to: [] as Address[],
  cc: [] as Address[],
  bcc: [] as Address[],
  subject: "",
  html: "",
  text: "",
  reference: void 0 as (Reference | void),
  files: void 0 as (string[] | void),
}

export const createMessageBody = (target: Partial<typeof baseDraft>) => {
  return Object.assign({}, baseDraft, target);
}


export const kShowBcc = Symbol("draft-show-bcc");
export const kShowCc = Symbol("draft-show-cc");
export const kSent = Symbol("draft-sent");

import { crossfade, fly } from "svelte/transition";
import { _delete, _post, HttpError } from "$lib/util";
import { Expunge } from "$lib/events";
import type { Attachment, Mailbox, User } from "$lib/types";

export const [crossin, crossout] = crossfade({
  duration: 300,
  fallback: (node) => fly(node, { duration: 300, y: 20 }),
});

let compose: any = null;

export const getComposer = () => {
  if(compose == null) {
    compose = mount(Compose, {
      target: document.body,
      props: {}
    });
  }
  return compose
} 

export const destroyComposer = () => {
  if(compose != null) {
    unmount(compose);
    compose = null;
  }
}

// Saves for one draft run strictly one at a time.
//
// save() is CREATE-new + DELETE-old (messages are immutable), so two overlapping saves
// both read the same draft.id, both create a message and both delete that single old
// id — leaving one of the two new messages orphaned in Drafts.
//
// Serializing in Window.svelte's autosave was not enough: send() calls save() directly,
// so clicking Send while an autosave was still in flight raced it anyway, and could
// even submit one copy while orphaning the other. The chain lives HERE because this is
// the one point every caller goes through. Keyed weakly by the draft object, so a
// closed compose tab takes its chain with it.
const saveChains = new WeakMap<Draft, Promise<unknown>>();

export const save = (draft: Draft): Promise<number> => {
  const run = (saveChains.get(draft) ?? Promise.resolve())
    .catch(() => {})
    .then(() => saveNow(draft));
  // Store a handle that cannot reject, so one failed save does not poison the chain
  // for every later one.
  saveChains.set(draft, run.catch(() => {}));
  return run;
}

const saveNow = async (draft: Draft) => {

  const { id, mailbox, key, files, carried, ...json } = draft;

  const { message } = await _post(`/api/mailboxes/${draft.mailbox}/messages`, createMessageBody({
    ...json,
    reference: referenceFor(json.reference, carried),
    files: files?.map(file => file.id).filter(Boolean) as string[],
  }));
  
  // Messages are immutable, so "saving" a draft means create-new + delete-old.
  // Don't rely on the server's EXPUNGE coming back over SSE to retire the old
  // row: it races the refetch that the matching EXISTS triggers (and is missed
  // outright if the list mounts after it fired), which leaves the saved draft
  // listed twice until a manual reload. We issued the delete, so we can announce
  // it ourselves — same event the SSE stream would deliver, so every open list
  // reconciles through the one code path.
  // Retire the superseded draft. Deliberately not awaited — the replacement already
  // exists and nothing should wait on a cleanup — but the failure must not be dropped
  // on the floor either: if this delete fails, the old message stays in Drafts as an
  // orphan, which is precisely the duplicate the save chain exists to prevent. Retry
  // once for a transient blip, treat "already gone" as done, and report the rest to
  // the console instead of pretending it worked.
  const retire = () => _delete(`/api/mailboxes/${mailbox}/messages/${id}`);
  const goneAlready = (e: any) => e instanceof HttpError && e.status === 404;
  retire()
    .catch(e => goneAlready(e) ? undefined : retire())
    .then(() => Expunge.dispatch({ command: "EXPUNGE", mailbox, uid: id }))
    .catch(e => {
      if(goneAlready(e)) return Expunge.dispatch({ command: "EXPUNGE", mailbox, uid: id });
      console.warn(`[raven] superseded draft ${id} could not be deleted; it may linger in Drafts`, e);
    })

  // Advance the draft's id INSIDE the serialized section. Callers also assign the
  // returned id, but that happens a microtask or two later — and the next entry in the
  // chain (another autosave, or the save inside send()) starts as soon as this resolves
  // and reads draft.id straight away. Writing it here means the handoff never depends
  // on which of those two lands first.
  draft.id = message.id;

  return message.id;
}

export const send = async (draft: Draft) => {
  const id = await save(draft);
  draft.id = id;
  await _post(`/api/mailboxes/${draft.mailbox}/messages/${draft.id}/submit`, {});
}

export const _blank = async (drafts: Mailbox) => {
  await getComposer().blank(drafts);
}

export const _reply = async (drafts: Mailbox, mailbox: Mailbox, id: number) => {
  await getComposer().reply(drafts, mailbox, id);
}

export const _replyAll = async (user: User, drafts: Mailbox, mailbox: Mailbox, id: number) => {
  await getComposer().replyAll(user, drafts, mailbox, id);
}

export const _forward = async (drafts: Mailbox, mailbox: Mailbox, id: number) => {
  await getComposer().forward(drafts, mailbox, id);
}

export const _open = async (mailbox: Mailbox, id: number) => {
  await getComposer().open(mailbox, id);
}
