<script lang="ts">
  import { goto } from "$app/navigation";
  import Formy from "$lib/Formy/Formy.svelte";
import { locale } from "$lib/locale";
  import Password from "$lib/Password.svelte";
  import TextField from "$lib/TextField.svelte";
  import { action, _post } from "$lib/util";
  import { onMount } from "svelte";
  import { setTabAccount } from "$lib/account";

  let username: string = "";
  let password: string = "";
  // "Add account" mode: same form, but the session keeps its existing accounts and
  // this one is appended. Arrives as ?add=1, optionally with ?username= prefilled
  // from a re-auth stub in the switcher.
  let isAdd = false;

  onMount(() => {
    const params = new URLSearchParams(location.search);
    isAdd = params.get("add") === "1";
    const prefill = params.get("username");
    if (prefill) username = prefill;
  });

  const login = action(async () => {
    const res = await _post("/api/login", isAdd ? { username, password, add: true } : { username, password });
    // The response names the account, so the tab points at the one whose password
    // was just typed — on a fresh login and on add alike.
    if (res?.id) setTabAccount(res.id);
    goto("/");
  })
</script>

<style>
  h1 {
    font-weight: 600;
    font-size: 1.75rem;
    text-align: center;
    margin: 4rem 0 var(--space-8) 0;
  }

  .box {
    width: 400px;
    box-sizing: border-box;
    max-width: 90%;
    margin: 0 auto var(--space-12) auto;
    padding: var(--space-8);
    display: flex;
    flex-direction: column;
  }

  .password {
    margin-top: var(--space-6);
  }

  .submit {
    margin: var(--space-6) var(--space-2) 0 auto;
  }
</style>

<svelte:head>
  <title>{isAdd ? $locale.Add_account : $locale.Sign_in}</title>
</svelte:head>

<div class="page">
  
  <h1>{isAdd ? $locale.Add_account : $locale.Sign_in}</h1>
  
  <Formy action={login} let:submit>
    
    <form class="box elev3" on:submit|preventDefault={submit}>
      
      <div class="username">
        <TextField validate required label={$locale.Username} bind:value={username} /> 
      </div>
      
      <div class="password">
        <Password label={$locale.Password} bind:value={password} />
      </div>

      <button type="submit" class="elev2 submit btn-light btn-primary">
        {$locale.Sign_in}
      </button>
    </form>
  </Formy>
</div>