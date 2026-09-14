import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useRealtimeFeed,
  type RealtimeFeedSubscription,
} from "./useRealtimeFeed";

/**
 * useRealtimeFeed.ts（本タスク5）のフック単体テスト。実Supabaseクライアントは
 * 使わず、`client.channel()`/`RealtimeChannel.on()`/`.subscribe()`を
 * モックして、以下を検証する:
 *   - 単一のフックが複数のテーブル/イベント/filterへパラメータ化されて
 *     購読すること（design.mdの「購読対象テーブルと絞り込み条件のみ
 *     パラメータ化する」要件）
 *   - 初回購読確立時・切断→再接続時にonSyncが呼び直されること
 *     （タスク5の観測可能な完了条件そのもの）
 *   - 接続状態（connected/disconnected）が公開されること（要件6.9）
 *   - アンマウント時に購読がクリーンアップされること
 *
 * 実際のローカルSupabaseスタックに対する結合テスト
 * （useRealtimeFeed.integration.test.ts）は、本ファイルではモックしている
 * publication登録・RLSポリシー（0008_realtime_publication.sql）が実際に
 * イベントを流すことまでを検証する。
 */

type OnCall = {
  type: string;
  filter: { event: string; schema: string; table: string; filter?: string };
  callback: (payload: unknown) => void;
};

type SubscribeCallback = (status: string, err?: Error) => void;

function createMockChannel() {
  const onCalls: OnCall[] = [];
  let subscribeCallback: SubscribeCallback | null = null;

  const channel = {
    on: vi.fn(
      (
        type: string,
        filter: OnCall["filter"],
        callback: (payload: unknown) => void,
      ) => {
        onCalls.push({ type, filter, callback });
        return channel;
      },
    ),
    subscribe: vi.fn((cb: SubscribeCallback) => {
      subscribeCallback = cb;
      return channel;
    }),
    unsubscribe: vi.fn(),
  };

  return {
    channel,
    onCalls,
    emitStatus(status: string, err?: Error) {
      subscribeCallback?.(status, err);
    },
    emitChangeFor(table: string) {
      for (const call of onCalls) {
        if (call.filter.table === table) {
          call.callback({});
        }
      }
    },
  };
}

function createMockClient() {
  const channelsByName = new Map<
    string,
    ReturnType<typeof createMockChannel>
  >();
  const channelFn = vi.fn((name: string) => {
    const mock = createMockChannel();
    channelsByName.set(name, mock);
    return mock.channel;
  });
  const removeChannel = vi.fn();

  return {
    client: { channel: channelFn, removeChannel } as unknown as Parameters<
      typeof useRealtimeFeed
    >[0]["client"],
    channelFn,
    removeChannel,
    channelsByName,
    latestChannel() {
      const mocks = [...channelsByName.values()];
      const latest = mocks[mocks.length - 1];
      if (!latest) {
        throw new Error("no channel was created yet");
      }
      return latest;
    },
  };
}

describe("useRealtimeFeed", () => {
  let onSync: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    onSync = vi.fn<() => Promise<void>>(async () => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("subscriptionsで指定したテーブル/イベント/filterがそのままpostgres_changes購読へパラメータ化される", () => {
    const { client, latestChannel } = createMockClient();

    renderHook(() =>
      useRealtimeFeed({
        client,
        channelName: "register-feed",
        subscriptions: [
          { table: "order_items" },
          { table: "table_sessions" },
          { table: "call_requests", event: "UPDATE" },
        ],
        onSync,
      }),
    );

    const { onCalls } = latestChannel();
    expect(onCalls).toHaveLength(3);
    expect(onCalls[0]).toMatchObject({
      type: "postgres_changes",
      filter: { event: "*", schema: "public", table: "order_items" },
    });
    expect(onCalls[0].filter.filter).toBeUndefined();
    expect(onCalls[1]).toMatchObject({
      filter: { event: "*", schema: "public", table: "table_sessions" },
    });
    expect(onCalls[2]).toMatchObject({
      filter: { event: "UPDATE", schema: "public", table: "call_requests" },
    });
  });

  it("filterパラメータを指定すると購読フィルタへそのまま渡る（客側の自セッション限定購読を想定）", () => {
    const { client, latestChannel } = createMockClient();

    renderHook(() =>
      useRealtimeFeed({
        client,
        channelName: "customer-order-feed-session-1",
        subscriptions: [
          { table: "order_items", filter: "session_id=eq.session-1" },
        ],
        onSync,
      }),
    );

    const { onCalls } = latestChannel();
    expect(onCalls[0].filter.filter).toBe("session_id=eq.session-1");
  });

  it("初回SUBSCRIBEDでonSyncが呼ばれ、statusがconnectedになる", async () => {
    const { client, latestChannel } = createMockClient();

    const { result } = renderHook(() =>
      useRealtimeFeed({
        client,
        channelName: "kitchen-feed",
        subscriptions: [{ table: "order_items" }],
        onSync,
      }),
    );

    expect(result.current.status).toBe("disconnected");
    expect(onSync).not.toHaveBeenCalled();

    act(() => {
      latestChannel().emitStatus("SUBSCRIBED");
    });

    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("切断→再接続でonSyncが呼び直され、一覧が最新状態に再取得される（タスク5の観測可能な完了条件）", async () => {
    const { client, latestChannel } = createMockClient();

    const { result } = renderHook(() =>
      useRealtimeFeed({
        client,
        channelName: "kitchen-feed",
        subscriptions: [{ table: "order_items" }],
        onSync,
      }),
    );

    act(() => {
      latestChannel().emitStatus("SUBSCRIBED");
    });
    await waitFor(() => expect(onSync).toHaveBeenCalledTimes(1));
    expect(result.current.status).toBe("connected");

    // ネットワーク切断を模擬する。
    act(() => {
      latestChannel().emitStatus("CLOSED");
    });
    await waitFor(() => expect(result.current.status).toBe("disconnected"));
    // 切断しただけではonSyncは呼ばれ直さない。
    expect(onSync).toHaveBeenCalledTimes(1);

    // 再接続を模擬する。
    act(() => {
      latestChannel().emitStatus("SUBSCRIBED");
    });
    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(onSync).toHaveBeenCalledTimes(2);
  });

  it.each(["TIMED_OUT", "CHANNEL_ERROR"])(
    "%sもdisconnectedとして扱われる",
    async (rawStatus) => {
      const { client, latestChannel } = createMockClient();

      const { result } = renderHook(() =>
        useRealtimeFeed({
          client,
          channelName: "kitchen-feed",
          subscriptions: [{ table: "order_items" }],
          onSync,
        }),
      );

      act(() => {
        latestChannel().emitStatus("SUBSCRIBED");
      });
      await waitFor(() => expect(result.current.status).toBe("connected"));

      act(() => {
        latestChannel().emitStatus(rawStatus, new Error("boom"));
      });
      await waitFor(() => expect(result.current.status).toBe("disconnected"));
    },
  );

  it("postgres_changesイベント受信のたびにonSyncを呼び直す（ペイロードの中身は使わない）", async () => {
    const { client, latestChannel } = createMockClient();

    renderHook(() =>
      useRealtimeFeed({
        client,
        channelName: "kitchen-feed",
        subscriptions: [{ table: "order_items" }],
        onSync,
      }),
    );

    act(() => {
      latestChannel().emitStatus("SUBSCRIBED");
    });
    await waitFor(() => expect(onSync).toHaveBeenCalledTimes(1));

    act(() => {
      latestChannel().emitChangeFor("order_items");
    });
    await waitFor(() => expect(onSync).toHaveBeenCalledTimes(2));
  });

  it("enabled=falseの間は購読を確立せず、statusはdisconnectedのまま", () => {
    const { client, channelFn } = createMockClient();

    const { result } = renderHook(() =>
      useRealtimeFeed({
        client,
        channelName: "kitchen-feed",
        subscriptions: [{ table: "order_items" }],
        onSync,
        enabled: false,
      }),
    );

    expect(channelFn).not.toHaveBeenCalled();
    expect(result.current.status).toBe("disconnected");
    expect(onSync).not.toHaveBeenCalled();
  });

  it("アンマウント時に購読をクリーンアップする（removeChannelが呼ばれる）", () => {
    const { client, latestChannel, removeChannel } = createMockClient();

    const { unmount } = renderHook(() =>
      useRealtimeFeed({
        client,
        channelName: "kitchen-feed",
        subscriptions: [{ table: "order_items" }],
        onSync,
      }),
    );

    const { channel } = latestChannel();
    unmount();

    expect(removeChannel).toHaveBeenCalledWith(channel);
  });

  it("毎レンダー新しい配列リテラルでsubscriptionsを渡しても、内容が同じなら購読を張り直さない", () => {
    const { client, channelFn } = createMockClient();

    const { rerender } = renderHook(
      ({ subscriptions }: { subscriptions: RealtimeFeedSubscription[] }) =>
        useRealtimeFeed({
          client,
          channelName: "kitchen-feed",
          subscriptions,
          onSync,
        }),
      { initialProps: { subscriptions: [{ table: "order_items" }] } },
    );

    expect(channelFn).toHaveBeenCalledTimes(1);

    // 内容は同じだが別の配列インスタンス（呼び出し側がuseMemoしない典型ケース）。
    rerender({ subscriptions: [{ table: "order_items" }] });

    expect(channelFn).toHaveBeenCalledTimes(1);
  });

  it("subscriptionsの内容が変わると購読を張り直す（旧チャンネルをremoveChannelし、新チャンネルを購読する）", () => {
    const { client, channelFn, removeChannel } = createMockClient();

    const { rerender } = renderHook(
      ({ subscriptions }: { subscriptions: RealtimeFeedSubscription[] }) =>
        useRealtimeFeed({
          client,
          channelName: "kitchen-feed",
          subscriptions,
          onSync,
        }),
      { initialProps: { subscriptions: [{ table: "order_items" }] } },
    );

    expect(channelFn).toHaveBeenCalledTimes(1);

    rerender({
      subscriptions: [{ table: "order_items" }, { table: "table_sessions" }],
    });

    expect(removeChannel).toHaveBeenCalledTimes(1);
    expect(channelFn).toHaveBeenCalledTimes(2);
  });
});
