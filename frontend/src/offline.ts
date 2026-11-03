import { openDB } from "idb";
import type { EventRecord, User } from "./types";

const database = openDB("event-reminder-offline", 2, {
  upgrade(db, oldVersion) {
    if (oldVersion < 1) db.createObjectStore("events");
    if (oldVersion < 2) db.createObjectStore("profiles");
  },
});

export async function cacheEvents(userId: string, events: EventRecord[]): Promise<void> {
  const db = await database;
  await db.put("events", events, userId);
}

export async function getCachedEvents(userId: string): Promise<EventRecord[]> {
  const db = await database;
  return (await db.get("events", userId)) ?? [];
}

export async function clearCachedUser(userId: string): Promise<void> {
  const db = await database;
  await db.delete("events", userId);
  await db.delete("profiles", userId);
}

export async function cacheProfile(user: User): Promise<void> {
  const db = await database;
  await db.put("profiles", user, user.id);
}

export async function getCachedProfile(userId: string): Promise<User | undefined> {
  const db = await database;
  return db.get("profiles", userId);
}
