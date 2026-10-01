import type {
  AccountingPosting,
  DemoSnapshot,
  PartyView,
  StepStatus,
} from "./types";
import { resetDemo, startDemo, useDemoState } from "./api";

const FLOW_NODES = [
  "SELLER ERP",
  "AI GATEWAY",
  "SIGN",
  "ENCRYPT",
  "OPEN TRADE NETWORK",
  "BUYER GATEWAY",
  "DECRYPT",
  "VERIFY",
  "BUYER ERP",
];

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function minor(value: number | undefined): string {
  return inr.format((value ?? 0) / 100);
}

function short(value: string | undefined, keep = 14): string {
  if (!value) return "—";
  return value.length <= keep + 4 ? value : `${value.slice(0, keep)}…${value.slice(-4)}`;
}

function Check({ ok }: { ok: boolean }) {
  return <span className={ok ? "check ok" : "check"}>{ok ? "✓" : "·"}</span>;
}

function StatusDot({ online }: { online: boolean }) {
  return <span className={`dot ${online ? "dot-on" : "dot-off"}`} />;
}

function TopBar({ snapshot }: { snapshot: DemoSnapshot | undefined }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">◈</span>
        <span className="brand-name">OPEN TRADE NETWORK</span>
      </div>
      <div className="topbar-right">
        {snapshot?.networkUrl && (
          <span className="net-chip" title={snapshot.networkUrl}>
            <StatusDot online /> sandbox · {snapshot.networkUrl.replace("http://", "")}
          </span>
        )}
        {snapshot && snapshot.phase !== "idle" && (
          <button className="btn btn-ghost" onClick={() => void resetDemo()}>
            RESET DEMO
          </button>
        )}
      </div>
    </header>
  );
}

function PartyCard({ party }: { party: PartyView }) {
  return (
    <div className="party-card">
      <div className="party-role">{party.role}</div>
      <div className="party-name">{party.companyName}</div>
      <div className="party-id mono">{party.participantId}</div>
      <div className="party-status">
        <StatusDot online={party.online} />
        {party.online ? "Gateway Online" : "Gateway Offline"}
      </div>
    </div>
  );
}

function Hero({ snapshot }: { snapshot: DemoSnapshot | undefined }) {
  const running = snapshot?.phase === "running";
  return (
    <div className="hero">
      <p className="hero-kicker">DEMO SANDBOX</p>
      <h1 className="hero-title">OPEN TRADE NETWORK</h1>
      <p className="hero-sub">Private, verifiable B2B trade data exchange</p>

      <div className="hero-strip">
        <PartyCard
          party={
            snapshot?.participants.seller ?? {
              participantId: "kerala-industrial-supplies",
              companyName: "Kerala Industrial Supplies Pvt Ltd",
              role: "SELLER",
              online: true,
            }
          }
        />
        <div className="network-card">
          <div className="network-card-title">OPEN TRADE NETWORK</div>
          <div className="network-card-row">Encrypted Data</div>
          <div className="network-card-plus">+</div>
          <div className="network-card-row">Signed Events</div>
          <div className="network-card-plus">+</div>
          <div className="network-card-row">Shared Verification</div>
        </div>
        <PartyCard
          party={
            snapshot?.participants.buyer ?? {
              participantId: "hyderabad-manufacturing",
              companyName: "Hyderabad Manufacturing Pvt Ltd",
              role: "BUYER",
              online: true,
            }
          }
        />
      </div>

      <div className="hero-actions">
        <button className="btn btn-primary" disabled={running} onClick={() => void startDemo()}>
          {running ? "RUNNING…" : "START DEMO"}
        </button>
        <button className="btn btn-secondary" disabled={running} onClick={() => void resetDemo()}>
          RESET DEMO
        </button>
      </div>
      <p className="hero-footnote">
        One click runs a complete invoice exchange end-to-end: canonicalize → sign → encrypt →
        submit → buyer verify → accept → ledger confirmed. Every step uses real cryptography and the
        live protocol code.
      </p>
    </div>
  );
}

function flowNodeState(snapshot: DemoSnapshot, index: number): StepStatus {
  const active = snapshot.steps.find((step) => step.status === "active");
  const doneNodes = snapshot.steps
    .filter((step) => step.status === "done")
    .map((step) => step.flowNode);
  const maxDone = doneNodes.length ? Math.max(...doneNodes) : -1;
  if (active && active.flowNode === index) return "active";
  if (index <= maxDone || snapshot.phase === "complete") return "done";
  return "pending";
}

function FlowDiagram({ snapshot }: { snapshot: DemoSnapshot }) {
  return (
    <div className="card flow-card">
      <div className="flow">
        {FLOW_NODES.map((node, index) => {
          const state = flowNodeState(snapshot, index);
          const isNet = node === "OPEN TRADE NETWORK";
          return (
            <div className="flow-item" key={node}>
              {index > 0 && <div className={`flow-link ${state !== "pending" ? "flow-link-on" : ""}`} />}
              <div className={`flow-node flow-${state} ${isNet ? "flow-net" : ""}`}>
                <span className="flow-glyph">
                  {state === "done" ? "✓" : state === "active" ? "●" : "○"}
                </span>
                <span className="flow-label">{node}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Pipeline({ snapshot }: { snapshot: DemoSnapshot }) {
  return (
    <div className="card">
      <div className="card-title">TRANSACTION PIPELINE</div>
      <ul className="pipeline">
        {snapshot.steps
          .filter((step) => step.id !== "setup")
          .map((step) => (
            <li key={step.id} className={`pipe-row pipe-${step.status}`}>
              <span className="pipe-check">
                {step.status === "done" ? "✓" : step.status === "active" ? "●" : step.status === "failed" ? "✕" : "○"}
              </span>
              <span className="pipe-label">{step.label}</span>
              {step.detail && <span className="pipe-detail">{step.detail}</span>}
            </li>
          ))}
      </ul>
    </div>
  );
}

function InvoiceCard({ snapshot }: { snapshot: DemoSnapshot }) {
  const invoice = snapshot.invoice;
  return (
    <div className="card">
      <div className="card-title">INVOICE · SELLER ERP</div>
      {invoice ? (
        <>
          <div className="invoice-lines">
            {invoice.lineItems.map((item) => (
              <div className="invoice-line" key={item.name}>
                <span className="invoice-item">{item.name}</span>
                <span className="invoice-qty">
                  {item.quantity} × {minor(item.rateMinor)}
                </span>
                <span className="invoice-amt">{minor(item.amountMinor)}</span>
              </div>
            ))}
          </div>
          <div className="invoice-totals">
            <div className="invoice-total-row">
              <span>Subtotal</span>
              <span>{minor(invoice.subtotalMinor)}</span>
            </div>
            <div className="invoice-total-row">
              <span>{invoice.taxLabel}</span>
              <span>{minor(invoice.taxMinor)}</span>
            </div>
            <div className="invoice-total-row grand">
              <span>Total</span>
              <span>{minor(invoice.totalMinor)}</span>
            </div>
          </div>
        </>
      ) : (
        <div className="placeholder">Waiting for ERP invoice…</div>
      )}
      {snapshot.erpStatusUpdates.length > 0 && (
        <div className="erp-status">
          ERP status:
          {snapshot.erpStatusUpdates.map((update) => (
            <span className="erp-chip" key={update.status}>{update.status}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function ProofRow({ label, value, ok, mono: isMono = true }: {
  label: string;
  value: string | undefined;
  ok?: boolean | undefined;
  mono?: boolean;
}) {
  return (
    <div className="proof-row">
      <span className="proof-label">{label}</span>
      <span className={`proof-value ${isMono ? "mono" : ""}`} title={value}>{value ? short(value, 30) : "…"}</span>
      {ok !== undefined && <Check ok={ok} />}
    </div>
  );
}

function ProofPanel({ snapshot }: { snapshot: DemoSnapshot }) {
  const doc = snapshot.document;
  const env = snapshot.envelope;
  const bv = snapshot.buyerVerification;
  const submitted = snapshot.events.find((event) => event.kind === "SUBMITTED");
  const accepted = snapshot.events.find((event) => event.kind === "ACCEPTED");
  return (
    <div className="card">
      <div className="card-title">CRYPTOGRAPHIC PROOF</div>

      <div className="proof-group">
        <div className="proof-group-title">Canonical document</div>
        <ProofRow label="SHA-256" value={doc?.sha256} ok={bv?.documentDigestMatch} />
        <ProofRow label="Ed25519 signature" value={doc?.signature} ok={bv?.documentSignatureValid} />
        {doc && (
          <details className="canonical-details">
            <summary>canonical JSON ({doc.canonicalJson.length} bytes)</summary>
            <pre className="mono canonical-json">{doc.canonicalJson}</pre>
          </details>
        )}
      </div>

      <div className="proof-group">
        <div className="proof-group-title">Encrypted envelope — network sees only this</div>
        <ProofRow label="Envelope ID" value={env?.header.envelopeId} />
        <ProofRow label="Ciphertext (sealed box)" value={env?.ciphertext} />
        <ProofRow label="Ciphertext SHA-256" value={env?.header.ciphertextHash} ok={bv?.ciphertextHashMatch} />
        <ProofRow label="Envelope signature" value={env?.signature} ok={bv?.envelopeSignatureValid} />
      </div>

      <div className="proof-group">
        <div className="proof-group-title">Salted commitment → shared ledger</div>
        <ProofRow label="Commitment digest" value={snapshot.commitment?.digest} ok={bv?.commitmentVerified} />
        <ProofRow label="Commitment salt" value={snapshot.commitment?.salt} />
        <ProofRow label="SUBMITTED event hash" value={submitted?.eventHash} />
        <ProofRow label="ACCEPTED event hash" value={accepted?.eventHash} />
        <ProofRow
          label="Hash chain integrity"
          value={snapshot.chainVerified ? "replayed & verified" : undefined}
          ok={snapshot.chainVerified}
          mono={false}
        />
      </div>

      {snapshot.intents.validationRequest && (
        <div className="proof-group">
          <div className="proof-group-title">Sovereign AI gateway intents (signed, policy-scoped)</div>
          <ProofRow label="seller → validation request" value={snapshot.intents.validationRequest.signature} ok />
          {snapshot.intents.acceptance && (
            <ProofRow label="buyer → acceptance" value={snapshot.intents.acceptance.signature} ok />
          )}
        </div>
      )}

      {bv && (
        <div className="verify-summary">
          <VerificationItem ok={bv.envelopeSignatureValid} label="envelope signature" />
          <VerificationItem ok={bv.ciphertextHashMatch} label="ciphertext hash" />
          <VerificationItem ok={bv.documentSignatureValid} label="document signature" />
          <VerificationItem ok={bv.documentDigestMatch} label="document digest" />
          <VerificationItem ok={bv.commitmentVerified} label="salted commitment" />
          <VerificationItem ok={bv.accountingMatch} label="accounting derivation" />
        </div>
      )}
    </div>
  );
}

function VerificationItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`verify-chip ${ok ? "verify-ok" : ""}`}>
      {ok ? "✓" : "·"} buyer verified {label}
    </span>
  );
}

function LedgerTimeline({ snapshot }: { snapshot: DemoSnapshot }) {
  return (
    <div className="card">
      <div className="card-title">SHARED EVENT LEDGER — append-only, hash-chained</div>
      {snapshot.events.length === 0 ? (
        <div className="placeholder">No ledger events yet</div>
      ) : (
        <ol className="timeline">
          {snapshot.events.map((event) => (
            <li className="timeline-row" key={event.eventId}>
              <div className="timeline-badge">{event.sequence}</div>
              <div className="timeline-body">
                <div className="timeline-head">
                  <span className={`event-kind kind-${event.kind.toLowerCase()}`}>{event.kind}</span>
                  <span className="mono timeline-actor">{event.actorParticipantId}</span>
                  <span className="timeline-time">{new Date(event.occurredAt).toLocaleTimeString()}</span>
                </div>
                <div className="timeline-hash mono" title={event.eventHash}>
                  hash {short(event.eventHash, 22)}
                </div>
                <div className="timeline-prev mono" title={event.previousHash || "genesis"}>
                  prev {event.previousHash ? short(event.previousHash, 22) : "genesis"}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function PostingTable({ title, postings }: { title: string; postings: AccountingPosting[] | undefined }) {
  return (
    <div className="posting-col">
      <div className="posting-title">{title}</div>
      {postings ? (
        <table className="posting-table">
          <tbody>
            {postings.map((posting, index) => (
              <tr key={index}>
                <td className="mono posting-acct">{posting.accountCode}</td>
                <td className={`posting-side ${posting.side === "DEBIT" ? "dr" : "cr"}`}>
                  {posting.side === "DEBIT" ? "DR" : "CR"}
                </td>
                <td className="posting-amt">{minor(posting.amountMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="placeholder">Pending…</div>
      )}
    </div>
  );
}

function AccountingPanel({ snapshot }: { snapshot: DemoSnapshot }) {
  const tx = snapshot.accountingTransaction;
  const sellerSet = tx?.postingSets[0];
  const buyerSet = tx?.postingSets[1];
  return (
    <div className="card">
      <div className="card-title">DERIVED ACCOUNTING — triple-entry posting sets</div>
      <div className="posting-grid">
        <PostingTable title={`SELLER · ${sellerSet?.participantId ?? "…"}`} postings={sellerSet?.postings} />
        <PostingTable title={`BUYER · ${buyerSet?.participantId ?? "…"}`} postings={buyerSet?.postings} />
      </div>
      {snapshot.buyerVerification?.accountingMatch && (
        <div className="accounting-note">
          ✓ Buyer re-derived identical posting sets from the decrypted document and proved them
          against the seller's salted commitment before signing acceptance.
        </div>
      )}
    </div>
  );
}

function Dashboard({ snapshot }: { snapshot: DemoSnapshot }) {
  const verified = snapshot.phase === "complete" && snapshot.transactionStatus === "CONFIRMED";
  const provisional = snapshot.transactionStatus === "PROVISIONAL" && !verified;
  return (
    <div className="dashboard">
      <div className="txn-header card">
        <div className="txn-id-block">
          <div className="txn-label">TRADE TRANSACTION</div>
          <div className="txn-number mono">{snapshot.invoice?.number ?? "INV-2026-0001"}</div>
        </div>
        <div className="txn-amount">{minor(snapshot.invoice?.totalMinor ?? 9440000)}</div>
        <div className={`txn-status ${verified ? "status-verified" : provisional ? "status-provisional" : ""}`}>
          {verified ? "✓ VERIFIED" : provisional ? "PROVISIONAL" : snapshot.phase === "error" ? "FAILED" : "RUNNING"}
        </div>
      </div>

      {snapshot.error && <div className="error-banner">{snapshot.error}</div>}

      <FlowDiagram snapshot={snapshot} />

      <div className="dashboard-grid">
        <div className="col-left">
          <Pipeline snapshot={snapshot} />
          <InvoiceCard snapshot={snapshot} />
        </div>
        <div className="col-right">
          <ProofPanel snapshot={snapshot} />
          <LedgerTimeline snapshot={snapshot} />
          <AccountingPanel snapshot={snapshot} />
        </div>
      </div>

      <footer className="disclaimer">
        Prototype sandbox — single process, in-memory ledger, simulated ERP endpoint. The
        cryptography, signatures, hash chain and verification are real.
      </footer>
    </div>
  );
}

export function App() {
  const snapshot = useDemoState();
  return (
    <div className="app">
      <TopBar snapshot={snapshot} />
      {!snapshot || snapshot.phase === "idle" ? (
        <Hero snapshot={snapshot} />
      ) : (
        <Dashboard snapshot={snapshot} />
      )}
    </div>
  );
}
