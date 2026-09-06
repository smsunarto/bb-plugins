import type { TunnelDetails } from "../shared/schema.ts";
import { TUNNEL_EDITOR as text, tunnelConnectionLabel, tunnelConnectorLabel } from "./labels.ts";
import { KeyValue, Label, Mono, Notice } from "./ui.tsx";

export function TunnelConnectors({ detail }: { detail: TunnelDetails }) {
  const { connectors, routes } = detail;
  return (
    <section className="cf-subsection" aria-label={text.connectors}>
      <Label>{text.connectors}</Label>
      {connectors.kind === "unavailable" ? (
        <Notice error>{connectors.message}</Notice>
      ) : (
        <>
          {connectors.value.length === 0 && <p>{text.noConnectors}</p>}
          <div className="cf-stack">
            {connectors.value.map((connector, index) => (
              <article className="cf-connector" key={connector.id ?? index}>
                <h4>{tunnelConnectorLabel(index)}</h4>
                <dl className="cf-kv">
                  <KeyValue label={text.connectorId}>
                    <Mono>{connector.id ?? text.unavailable}</Mono>
                  </KeyValue>
                  <KeyValue label={text.architecture}>
                    {connector.architecture ?? text.unavailable}
                  </KeyValue>
                  <KeyValue label={text.version}>{connector.version ?? text.unavailable}</KeyValue>
                  <KeyValue label={text.startedAt}>
                    {connector.startedAt ?? text.unavailable}
                  </KeyValue>
                  <KeyValue label={text.configVersion}>
                    {connector.configVersion ?? text.unavailable}
                  </KeyValue>
                </dl>
                {routes.kind === "editable" &&
                  routes.version !== undefined &&
                  connector.configVersion !== undefined &&
                  connector.configVersion < routes.version && (
                    <p className="cf-help">{text.configLag}</p>
                  )}
                {connector.connections.length === 0 && (
                  <p className="cf-help">{text.noConnections}</p>
                )}
                {connector.connections.map((connection, connectionIndex) => (
                  <details
                    key={connection.id ?? connectionIndex}
                    className="cf-connector-connection"
                  >
                    <summary>
                      {tunnelConnectionLabel(connectionIndex)} ·{" "}
                      {connection.colo ?? text.unavailable}
                    </summary>
                    <dl className="cf-kv">
                      <KeyValue label={text.connectionId}>
                        <Mono>{connection.id ?? text.unavailable}</Mono>
                      </KeyValue>
                      <KeyValue label={text.colo}>{connection.colo ?? text.unavailable}</KeyValue>
                      <KeyValue label={text.openedAt}>
                        {connection.openedAt ?? text.unavailable}
                      </KeyValue>
                      <KeyValue label={text.originIp}>
                        <Mono>{connection.originIp ?? text.unavailable}</Mono>
                      </KeyValue>
                      <KeyValue label={text.version}>
                        {connection.version ?? text.unavailable}
                      </KeyValue>
                    </dl>
                  </details>
                ))}
              </article>
            ))}
          </div>
        </>
      )}
      <p className="cf-help">
        {text.observedAt} {detail.observedAt}
      </p>
    </section>
  );
}
