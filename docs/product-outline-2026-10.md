# Agent Control Deck: next-generation product outline

*Working concept: Agent Inbox · Discussion draft v0.1 · 14 October 2026 (AEST)*

This outline captures the product direction discussed on 13 October. It is a foundation for further design, not an implementation specification or approved roadmap. “Agent Inbox” describes the original intent; no rename has been decided.

## 1. Product thesis

A general knowledge-work IDE that brings tasks, agent work, documents and human decisions into one durable workspace.

Agents carry work forward and bring consequential questions, findings and reviewable outputs to the human with the context needed to engage. The product amplifies expert judgment and uses human attention deliberately while preserving an experimental, curious approach.

The task provides continuity; the inbox brings work requiring attention; the document provides a durable surface for review. Chat remains useful, but important feedback and decisions need a home beyond a linear conversation.

## 2. User and problem

### Primary starting user

An expert researcher working through documents, tickets, investigations and decisions. Code can be an output or research tool, but software delivery is not the organising model.

### Current friction

- The existing Deck helps connect multiple Claude Code/tmux sessions to tasks, but the dashboard and the actual working conversations remain separate.

- Monitoring sessions and reconstructing context consumes attention.

- Linear chats accumulate lists of changes; feedback becomes detached from the passages it concerns.

- Document editing and patching can be time-intensive. Support independent working documents with a focused review flow to make feedback and revisions easier.

- Errors may originate in deeply nested source documents, misunderstood instructions or an unclear point in a transcript.

- Research quality often depends on reasoning and expert knowledge. Template completion or automated checks cannot establish correctness.

### Product opportunity

Make it easier to understand work, intervene precisely, preserve decisions and improve the process without requiring the human to continuously supervise execution.

## 3. Core principles

### 3.1 Document-centred review

Highlight passages, attach threaded feedback, suggest replacements and edit directly. Preserve the relationship between feedback and the relevant version as the document changes.

### 3.2 Task-centred continuity

Unite the work under the task it is intended to accomplish: artifacts, conversations, investigations, decisions and follow-up actions. A task survives individual sessions and attempts.

### 3.3 Deliberate use of human attention

Let agents own as much of the process as they appropriately can, with predictable boundaries and inspectable activity. Bring the human in through considered interactions backed by relevant context.

### 3.4 Affordances toward a zero-defect process

Support noticing defects, understanding their origins, correcting outputs and improving sources, skills or tools. This is a quality-improvement aspiration, not a guarantee of error-free research. Uncertainty and open questions must remain expressible.

### Cross-cutting constraint: exploratory freedom

Support following unusual observations, branching investigations and reconsidering assumptions. Do not force discovery into a rigid sequence or codify the precise current workflow into the application.

## 4. Reusable capabilities to explore

These are candidate capabilities, not a committed feature list.

### A. Durable document review

- Passage-anchored threads, annotations, direct edits and proposed patches.

- Review individual changes without rereading unrelated rewritten sections.

- Preserve feedback across revisions; make stale or displaced anchors visible.

- Keep working artifacts independent of external publishing systems, with deliberate publication or synchronisation.

### B. Tasks and an attention inbox

- Gather related work and outputs under an enduring task.

- Surface meaningful findings, review requests, ambiguities and blockers.

- Include the question, supporting context and available next actions.

- Allow quick resolution or deeper inspection without requiring constant session monitoring.

### C. Inspectable, steerable working context

- Explore retrieval from a task description, ticket, document or selected passage.

- Show relevant documents, data and conversations with excerpts, relevance and search boundaries.

- Let the human pin, exclude, correct or expand context.

- Reuse context for both human review and agent execution.

- Treat retrieval as ongoing investigation; initial task creation need not discover everything.

### D. Evidence and execution provenance

- “What supports this claim?”: citations to specific source passages, data and observations.

- “How did this output arise?”: available messages, retrieved material, tool results, intermediate artifacts and edits.

- Distinguish observation, assumption and inference.

- State when an origin cannot be established; recorded activity is not complete access to a model’s internal reasoning.

### E. Invocable review agents

- Review an artifact, a passage, or the available history of an investigation.

- Trace questionable assumptions, conflicting sources and unsupported conclusions.

- Surface unusual observations or abandoned leads worth expert attention.

- Anchor findings to evidence and allow targeted follow-up.

### F. Linked proposed changes

- Review related edits across artifacts, source documentation and skills.

- Explain why each change follows from a correction or decision.

- Distinguish known dependencies from suspected effects.

- A linked list of changes may suffice; a visual graph is an open design choice.

### G. Inline process-defect reporting

- Flag a problem at the point it appears.

- Preserve the relevant output, context, source or skill version, and human correction.

- Separate immediate repair from a proposed reusable improvement.

- Keep expert review central when deciding the scope and meaning of a change.

## 5. Role of skills and workflow

Skills describe the intended output, how to approach the work, how to use available tools and what requires expert judgment. They may include document templates, review criteria and expected outcomes for particular stages.

The framework should support these conventions without hard-coding each domain workflow. A comparison between competing signals can remain a document format; shared annotation, investigation and revision capabilities provide the product value.

Agents can raise inconsistencies and suggest improvements. The expert determines whether the cause is missing context, faulty documentation, a skill defect, a tool problem or a task-specific exception. Automatic rewriting of skills is not an assumed solution.

## 6. Illustrative use case: detection-signal research

*An example to test the framework, not its fixed data model.*

1. Start a task with an initial question and available references.

2. Conduct research and develop the expected research document.

3. Produce a signal proposal describing its operation, affected behaviour, evidence and alternatives.

4. Review through annotations, direct edits, questions and targeted investigations.

5. Make an expert decision, preserving the rationale and remaining uncertainties.

6. Produce or update the relevant documentation through reviewable changes.

7. When a defect appears, inspect its origin and consider the appropriate process improvement.

The same capabilities should support other knowledge work without introducing signal-specific application logic.

## 7. Boundaries and non-goals

- Not a software-only IDE or a dashboard whose primary unit is a coding session.

- Not a fixed graph encoding the precise current workflow.

- Not a hierarchy of pretend employees or management-role agents.

- Not an assumption that a polished summary, checklist or passing test establishes research correctness.

- Not automatic institutional learning from every correction.

- Not a requirement for every task to complete every stage or use every feature.

Predictable execution must coexist with uncertainty, expert override and open investigation.

## 8. How to establish value

### Candidate evaluation questions

- Can the human understand and resolve a review item without reconstructing the investigation across chats?

- Does passage-level feedback make corrections more precise and reduce repeated explanations?

- Can important findings and decisions be recovered after the session ends?

- Can a reviewer trace an error to its source, or clearly identify what remains unknown?

- Does the inbox reduce monitoring without creating excessive interruptions?

- Can the human pursue a surprising finding without fighting the workflow?

Assess these through representative research tasks and qualitative review. Speed and output volume alone would be insufficient success measures.

## 9. Possible first slice — proposal, not a commitment

Explore one end-to-end review experience:

- A task containing an independently editable research document.

- Anchored discussion, direct edits and reviewable agent revisions.

- Access to the relevant sources and execution history.

- A focused review request arriving in the inbox.

- A recorded human decision and a deliberate final-document update.

Use an existing template to make the experiment concrete while testing reusable capabilities. Broader retrieval, cross-document impact tracing and advanced orchestration can be evaluated separately.

## 10. Open product questions

- What is the smallest useful relationship between task, artifact, discussion, investigation and decision?

- How should annotations behave when a passage is substantially rewritten or deleted?

- What should trigger an interruption versus remain available for later inspection?

- How much context can be gathered usefully from a sparse initial request?

- How should conflicting, stale or inaccessible sources be represented?

- Which execution records are available from the chosen harness, and how should they be retained?

- How are skills selected, versioned and improved without accumulating contradictory exceptions?

- How does publication back to Confluence or a ticket system handle concurrent external edits?

- What autonomy boundaries should be explicit and configurable?

- Which features demonstrate enough benefit to justify a dedicated application?

## 11. Status and next discussion

The core direction is a task-oriented, document-centred knowledge-work environment that brings meaningful work to the human and supports expert-led process improvement.

Durable evidence/provenance, retrieval mechanics, review-agent behaviour, dependency tracing and the initial product slice remain design proposals to refine. Architecture, integrations, naming and implementation scope remain undecided.

---

Import provenance: the repository owner supplied this assistant-written historical product outline for `bakkerme/agent-control-deck` on 18 October 2026. After being told the repository is public, the owner confirmed that this outline belongs to the public side of the software and approved publishing it together with the experimental branch. The confidentiality boundary remains exclusion of employer-specific examples and data; this outline describes general product direction rather than an employer or customer implementation. The source Page remains unchanged.

Historical source: private ChatGPT product-outline Page; URL omitted from the repository copy.

Fetched: 18 October 2026. Preserved as discussion direction, not an approved roadmap. Public-copy edits approved by the owner: omit the private source URL and express the document-review opportunity as a general product goal rather than a claim about an existing in-house workflow.

Implementation slice (18 October 2026): task-associated embedded Claude Agent SDK chats, with streaming, permissions, cancellation and durable session resume. Document review, retrieval and orchestration remain future work. See [embedded chat experiment](embedded-chat-experiment.md).
