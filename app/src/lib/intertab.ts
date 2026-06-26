/// create an inter-tab notification system through localStorage
export const intertab = <T>(key: string) => {
  
  let listening = false;

  const handle = (event: StorageEvent) => {
    if(event.key !== key) return;

    let old_value: T | undefined;
    try {
      old_value = event.oldValue == null ? undefined : JSON.parse(event.oldValue);
    } catch {
      old_value = undefined;
    }

    let new_value: T | undefined;
    try {
      new_value = event.newValue == null ? undefined : JSON.parse(event.newValue);
    } catch {
      new_value = undefined;
    }

    internal_dispatch(new_value, old_value);
  }

  const listen = () => {
    listening = true;
    window.addEventListener("storage", handle);
  }

  const unlisten = () => {
    listening = false;
    window.removeEventListener("storage", handle);
  }

  const internal_dispatch = (new_value: T | undefined, old_value: T | undefined) => {
    for(const fn of listeners) {
      fn(new_value as T, old_value);
    }
  }

  const listeners: ((newValue: T, oldValue: T | undefined) => void)[] = [];

  const set = (value: T) => {
    localStorage.setItem(key, JSON.stringify(value));
  }

  const get = () => {
    try {
      const v = localStorage.getItem(key);
      if(typeof v === "string") {
        return JSON.parse(v)
      } else {
        return undefined;
      }
    } catch(e) {
      return undefined;
    }
  }

  const watch = (fn: (newValue: T, oldValue: T | undefined) => void) => {
    
    listeners.push(fn);
    if(!listening) listen();

    const unwatch = () => {
      const i = listeners.indexOf(fn);
      if(i !== -1) {
        listeners.splice(i, 1);
        if(listening && listeners.length === 0) {
          unlisten();
        }
      }
    }

    return unwatch
  }

  return { set, get, watch }

}