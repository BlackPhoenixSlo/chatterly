"use client";

/**
 * useOFUser — single fan's full OF profile, including the `subscribedOnData`
 * block that holds the live spend breakdown + subscription state. Powers
 * the FanDrawer's stats grid (matches what the desktop app shows).
 *
 * Cached for 5 minutes — these numbers change on every PPV/tip but the
 * inbox refetches the chat list often enough that the slight staleness
 * is invisible. Set to refetch on window focus so flipping back to the
 * tab after a paid action refreshes the panel.
 *
 * Errors are swallowed by React Query → we surface them through the
 * existing `error` slot, but the drawer keeps showing the DB-derived
 * fields so a flaky OF call doesn't blank the panel.
 */

import { useQuery } from "@tanstack/react-query";

import { relay } from "@/lib/relay";

export interface OFSubscribedOnData {
  price?: number;
  newPrice?: number;
  regularPrice?: number;
  subscribePrice?: number;
  subscribeAt?: string | null;
  expiredAt?: string | null;
  renewedAt?: string | null;
  status?: string | null;
  isMuted?: boolean;
  unsubscribeReason?: string | null;
  duration?: string | null;
  tipsSumm?: number;
  subscribesSumm?: number;
  messagesSumm?: number;
  postsSumm?: number;
  streamsSumm?: number;
  totalSumm?: number;
}

export interface OFListState {
  id: string | number;
  type: string;
  name?: string;
  hasUser?: boolean;
  canAddUser?: boolean;
  cannotAddUserReason?: string | null;
}

export interface OFUser {
  id?: number;
  name?: string;
  username?: string;
  avatar?: string | null;
  lastSeen?: string | null;
  subscribedOnData?: OFSubscribedOnData;
  listsStates?: OFListState[];
  [k: string]: unknown;
}

export function useOFUser(accountId: string, fanId: number) {
  return useQuery<OFUser>({
    queryKey: ["of-user", accountId, fanId],
    enabled: !!accountId && !!fanId,
    queryFn: () =>
      relay.get<OFUser>(`/api/of/v2/users/${fanId}`, { accountId }),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}
