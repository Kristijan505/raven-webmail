<script lang="ts">
  // Initials avatar: "Kristijan Pravica" -> "KP", single name -> its first
  // letter, no name at all -> first letter of the username.
  import type { User } from "$lib/types";
  export let user: User;
  export let size = "2.25rem";
  export let variant: "brand" | "light" = "brand";

  const initialsOf = (u: User): string => {
    const name = (u?.name || "").trim();
    if (name) {
      const parts = name.split(/\s+/).filter(Boolean);
      const first = parts[0]?.[0] ?? "";
      const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
      return (first + last).toUpperCase();
    }
    return ((u?.username || "?").trim()[0] || "?").toUpperCase();
  };

  $: initials = initialsOf(user);
</script>

<div
  class="avatar {variant}"
  style="width:{size};height:{size};font-size:calc({size} * 0.4);"
  aria-hidden="true"
>
  {initials}
</div>

<style>
  .avatar {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-full);
    font-weight: 600;
    line-height: 1;
    user-select: none;
    box-sizing: border-box;
  }

  /* On surfaces (the account menu). */
  .avatar.brand {
    background: var(--red);
    color: #fff;
  }

  /* On the red navbar — a translucent white disc reads cleanly on brand red. */
  .avatar.light {
    background: rgba(255, 255, 255, 0.22);
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.45);
  }
</style>
