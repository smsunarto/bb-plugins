import { useCallback, useEffect, useRef } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { SchemaOutput, StandardSchemaV1 } from "./standard-schema.js";

export interface RealtimeInvalidationOptions<
  Schema extends StandardSchemaV1,
> {
  readonly channel: string;
  readonly schema: Schema;
  readonly keys: (payload: SchemaOutput<Schema>) => readonly QueryKey[];
  readonly reconnect?: readonly QueryKey[];
  readonly onInvalidPayload?: (issues: readonly unknown[]) => void;
}

/**
 * Validate ephemeral bb realtime signals and use them only to invalidate
 * authoritative queries. A reconnect invalidates the declared module roots.
 */
export function useRealtimeInvalidation<
  const Schema extends StandardSchemaV1,
>({
  channel,
  schema,
  keys,
  reconnect = [],
  onInvalidPayload,
}: RealtimeInvalidationOptions<Schema>): void {
  const queryClient = useQueryClient();

  useRealtime(
    channel,
    useCallback(
      (payload: unknown) => {
        void Promise.resolve(schema["~standard"].validate(payload)).then(
          async (result) => {
            if (result.issues !== undefined) {
              if (onInvalidPayload) onInvalidPayload(result.issues);
              else console.warn(
                `[bb-kit] ignored invalid realtime payload on ${channel}`,
                result.issues,
              );
              return undefined;
            }
            await Promise.all(
              keys(result.value).map((queryKey) =>
                queryClient.invalidateQueries({ queryKey }),
              ),
            );
            return undefined;
          },
        );
      },
      [channel, keys, onInvalidPayload, queryClient, schema],
    ),
  );

  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (
      previousConnection.current === "reconnecting"
      && connection === "connected"
    ) {
      void Promise.all(
        reconnect.map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    }
    previousConnection.current = connection;
  }, [connection, queryClient, reconnect]);
}
