# Round 1 dispositions

- adjudicator: gpt-6-astra `/root/r1_adjudication`
- recorder: gpt-5.6-sol `/root`

| Finding | Decision | Requirement change | Reason/evidence |
|---|---|---|---|
| F-1-01 | accepted | v0→v1 FR-003/007/010, RAC-003 | Existing VoiceMeeter direct mic and app mixer must be mutually exclusive. |
| F-1-02 | accepted | v0→v1 FR-005/006/007/009, RAC-002/006 | Old fingerprint proves neither remote reachability nor current ChatGPT input. |
| F-1-03 | modified | v0→v1 FR-002/010/012, NFR-004/005, RAC-004 | Metadata has no CAS. Reserved LiveKit identity supplies runtime singleton; first-wins is withdrawn. |
| F-1-04 | accepted | v0→v1 NFR-004, RAC-007 | Data ban applies to new diagnostics/state, not required media transport or explicit recording. |

No additional user decision is required.
