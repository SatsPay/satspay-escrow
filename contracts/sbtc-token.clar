;; title: sbtc-token (mock for testing)
;; description:
;;   Minimal SIP-010 fungible token used in Clarinet simnet tests only.
;;   DO NOT deploy this to testnet or mainnet.

(define-fungible-token sbtc)

;; SIP-010 transfer
(define-public (transfer
    (amount    uint)
    (sender    principal)
    (recipient principal)
    (memo      (optional (buff 34))))
  (begin
    (asserts! (is-eq tx-sender sender) (err u401))
    (ft-transfer? sbtc amount sender recipient)
  )
)

;; Mint tokens (open in mock, gated in production)
(define-public (mint (amount uint) (recipient principal))
  (ft-mint? sbtc amount recipient)
)

;; SIP-010 getters
(define-read-only (get-name)        (ok "Mock sBTC"))
(define-read-only (get-symbol)      (ok "msBTC"))
(define-read-only (get-decimals)    (ok u8))
(define-read-only (get-balance (who principal)) (ok (ft-get-balance sbtc who)))
(define-read-only (get-total-supply) (ok (ft-get-supply sbtc)))
(define-read-only (get-token-uri)   (ok none))
