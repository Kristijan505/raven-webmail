import Notifier from "./Notifier.svelte";
import { mount } from "svelte";

type NotifierInstance = {
  error: (message: string) => void;
  message: (message: string) => void;
};

const noopNotifier: NotifierInstance = {
  error: () => {},
  message: () => {},
};

let instance: NotifierInstance | null = null;

const createNotifier = (): NotifierInstance => {
  if (typeof document === "undefined") return noopNotifier;

  try {
    const notifier = mount(Notifier, {
      target: document.body,
      props: {
        messages: [],
        maxStack: 3,
        duration: 3000,
      },
    }) as unknown as Partial<NotifierInstance>;

    if (typeof notifier.message === "function" && typeof notifier.error === "function") {
      return notifier as NotifierInstance;
    }
  } catch (e) {
    console.error("Notifier initialization failed", e);
  }

  return noopNotifier;
};

export const getNotifier = (): NotifierInstance => {
  if (instance == null) {
    instance = createNotifier();
  }
  return instance;
};

export const _error = (message: string) => {
  try {
    getNotifier().error(message);
  } catch (e) {
    console.error("Notifier error() failed", e);
  }
};

export const _message = (message: string) => {
  try {
    getNotifier().message(message);
  } catch (e) {
    console.error("Notifier message() failed", e);
  }
};

export default getNotifier;
