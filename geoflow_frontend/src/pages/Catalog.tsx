import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";

export default function Catalog() {
  const { data, isLoading, error } = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });

  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <p className="eyebrow">Registry</p>
          <h1 className="title">Node catalog</h1>
          <p className="lede">
            The processing steps a workflow can be built from. Derived from the code
            registry, so this is always what the server will actually run.
          </p>
        </div>
        {data && <span className="chip">{data.length} nodes</span>}
      </div>

      {isLoading && <span className="sr-label" role="status">Loading the node catalog…</span>}
      {isLoading && (
        <div className="node-grid" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card node-card">
              <div className="skeleton" style={{ height: 13, width: "45%" }} />
              <div className="skeleton" style={{ height: 11, width: "92%", marginTop: 12 }} />
              <div className="skeleton" style={{ height: 11, width: "70%", marginTop: 6 }} />
              <div className="skeleton" style={{ height: 18, width: "60%", marginTop: 16 }} />
            </div>
          ))}
        </div>
      )}
      {error && <div className="error" role="alert">{(error as Error).message}</div>}

      {/* A list, and announced as one: "12 items" tells a screen-reader user
          the size of the catalog before they start arrowing through it. */}
      <div className="node-grid" role="list">
        {data?.map((n) => (
          <div key={n.type_name} className="card node-card" role="listitem">
            <div className="node-name">{n.type_name}</div>
            <p className="node-desc">{n.description}</p>
            <div className="io">
              {([["in", n.input_schema], ["out", n.output_schema], ["params", n.param_schema]] as const)
                .map(([label, schema]) => {
                  const keys = Object.keys(schema);
                  return (
                    <div key={label} className="io-row">
                      <span className="io-key">{label}</span>
                      {keys.length ? (
                        <span className="io-vals">
                          {keys.map((k) => (
                            <span key={k} className={`chip${label === "out" ? " accent" : ""}`}>
                              {k}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="io-none">—</span>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}