import { expect } from "chai";
import crypto from "crypto";
import { describe, it, before, after } from "mocha";
import prisma from "../src/lib/prisma";
import OrganizationSvc from "../src/services/organization.service";
import OrganizationMemberRepo from "../src/repositories/organization-member.repository";
import OrganizationInviteRepo from "../src/repositories/organization-invite.repository";
import CaseCopySvc from "../src/services/case-copy.service";
import CaseCopyQueue from "../src/queues/case-copy.queue";
import CaseRepo from "../src/repositories/case.repository";
import ChatRepo from "../src/repositories/chat.repository";
import CaseSvc from "../src/services/case.service";
import CaseAccess from "../src/utils/case-access";
import DocumentExtractionQueue from "../src/queues/document-extraction.queue";

describe("Case portfolio", () => {
  const createdUserIds: string[] = [];
  const copiedKeys: [string, string][] = [];
  const originalCopyObject = CaseCopySvc.copyObject;
  const originalEnqueueMany = DocumentExtractionQueue.enqueueMany;
  const enqueued: string[] = [];

  before(() => {
    // No S3 or SQS in tests.
    CaseCopySvc.copyObject = async (from, to) => {
      copiedKeys.push([from, to]);
    };
    DocumentExtractionQueue.enqueueMany = (ids: string[]) => {
      enqueued.push(...ids);
    };
  });

  after(async () => {
    CaseCopySvc.copyObject = originalCopyObject;
    DocumentExtractionQueue.enqueueMany = originalEnqueueMany;
    const orgs = await prisma.organization.findMany({ where: { createdById: { in: createdUserIds } }, select: { id: true } });
    const orgIds = orgs.map((o) => o.id);
    const caseIds = (await prisma.case.findMany({ where: { organizationId: { in: orgIds } }, select: { id: true } })).map((c) => c.id);
    const docs = await prisma.document.findMany({ where: { organizationId: { in: orgIds } }, select: { fileId: true } });
    await prisma.event.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.note.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.document.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.file.deleteMany({ where: { id: { in: docs.map((d) => d.fileId!).filter(Boolean) } } });
    await prisma.consultation.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
    await prisma.caseCopy.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.consultationCopy.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organizationInvite.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  async function makeUser(name?: string) {
    const userId = crypto.randomUUID();
    await prisma.user.create({
      data: { id: userId, name, email: `portfolio-${userId}@example.com`, username: `portfolio-${userId}` },
    });
    createdUserIds.push(userId);
    return userId;
  }

  async function makeOrg(name: string) {
    const ownerId = await makeUser(`${name} Owner`);
    const org = await OrganizationSvc.create(ownerId, name, undefined, "PH");
    return { ownerId, organizationId: org.id };
  }

  async function memberOf(organizationId: string, name?: string) {
    const userId = await makeUser(name);
    await OrganizationMemberRepo.add(organizationId, userId, "MEMBER");
    return userId;
  }

  async function personalOf(userId: string) {
    return prisma.organization.findFirst({ where: { createdById: userId, isPersonal: true } });
  }

  describe("leaving queues a copy of every case the leaver created", () => {
    it("copies their own cases (archived too), never other members' cases", async () => {
      const firm = await makeOrg("Ash Firm");
      const leaverId = await memberOf(firm.organizationId, "Leah");
      const mine = await CaseRepo.create(firm.organizationId, leaverId, { caseName: "Mine" });
      const archived = await CaseRepo.create(firm.organizationId, leaverId, { caseName: "Old" });
      await prisma.case.update({ where: { id: archived.id }, data: { status: "ARCHIVED" } });
      await CaseRepo.create(firm.organizationId, firm.ownerId, { caseName: "Theirs" });

      await OrganizationSvc.leave(firm.organizationId, leaverId);

      const portfolio = await personalOf(leaverId);
      expect(portfolio).to.not.equal(null);
      // They land in their portfolio, so they still have a workspace.
      expect((await OrganizationMemberRepo.findAnyForUser(leaverId))?.organizationId).to.equal(portfolio!.id);
      const queued = await prisma.caseCopy.findMany({ where: { userId: leaverId } });
      expect(queued.map((q) => q.sourceCaseId).sort()).to.deep.equal([mine.id, archived.id].sort());
      expect(queued.every((q) => q.targetOrganizationId === portfolio!.id && q.sourceOrganizationName === "Ash Firm")).to.equal(true);
    });

    it("queues copies when an admin removes the member, and when they switch orgs by invite", async () => {
      const firm = await makeOrg("Bea Firm");
      const removedId = await memberOf(firm.organizationId);
      const switcherId = await memberOf(firm.organizationId);
      await CaseRepo.create(firm.organizationId, removedId, { caseName: "R" });
      await CaseRepo.create(firm.organizationId, switcherId, { caseName: "S" });
      const other = await makeOrg("Cal Firm");
      await OrganizationInviteRepo.create(other.organizationId, switcherId, "MEMBER");

      await OrganizationSvc.removeMember(firm.organizationId, "OWNER", firm.ownerId, removedId);
      await OrganizationSvc.acceptInvite(other.organizationId, switcherId);

      expect(await prisma.caseCopy.count({ where: { userId: removedId } })).to.equal(1);
      expect(await prisma.caseCopy.count({ where: { userId: switcherId } })).to.equal(1);
      expect((await OrganizationMemberRepo.findAnyForUser(switcherId))?.organizationId).to.equal(other.organizationId);
    });

    it("leaves the originals with the organization, and the leaver can no longer reach them", async () => {
      const firm = await makeOrg("Dee Firm");
      const leaverId = await memberOf(firm.organizationId);
      const stayerId = await memberOf(firm.organizationId);
      const original = await CaseRepo.create(firm.organizationId, leaverId, { caseName: "Kept" });

      await OrganizationSvc.leave(firm.organizationId, leaverId);

      expect((await CaseAccess.loadAccessibleCase(original.id, stayerId)).id).to.equal(original.id);
      const err = await CaseAccess.loadAccessibleCase(original.id, leaverId).catch((e) => e);
      expect(err.statusCode).to.equal(404);
      const listed = await CaseRepo.list(firm.organizationId, stayerId, 1, 50);
      const row = listed.data.find((c) => c.id === original.id);
      expect(row?.createdBy?.id).to.equal(leaverId);
      expect(row?.createdBy?.isMember).to.equal(false);
    });
  });

  describe("CaseCopySvc.copy", () => {
    it("copies the case with its parties, timeline, events, documents and consultations", async () => {
      const firm = await makeOrg("Eli Firm");
      const leaverId = await memberOf(firm.organizationId, "Lou");
      const source = await CaseRepo.create(firm.organizationId, leaverId, {
        caseName: "Full",
        notes: "Some notes",
        parties: [{ name: "Acme", designation: "Plaintiff" }],
      });
      const file = await prisma.file.create({ data: { filename: "brief.pdf", s3Key: `documents/cases/${source.id}/1-ab.pdf` } });
      const consultation = await prisma.consultation.create({
        data: { userId: firm.ownerId, organizationId: firm.organizationId, caseId: source.id, title: "Chat" },
      });
      const question = await prisma.message.create({ data: { consultationId: consultation.id, role: "user", content: "Q?" } });
      await prisma.message.create({
        data: { consultationId: consultation.id, role: "assistant", content: "A.", parentMessageId: question.id },
      });
      const doc = await prisma.document.create({
        data: {
          userId: leaverId,
          organizationId: firm.organizationId,
          caseId: source.id,
          consultationId: consultation.id,
          name: "brief.pdf",
          fileId: file.id,
          ragStatus: "READY",
        },
      });
      await prisma.caseTimelineEvent.create({ data: { caseId: source.id, title: "Filed", documentId: doc.id, chunkId: "chunk-1" } });
      await prisma.event.create({
        data: {
          userId: leaverId,
          organizationId: firm.organizationId,
          caseId: source.id,
          title: "Hearing",
          dateTime: new Date(),
          googleEventId: `g-${crypto.randomUUID()}`,
          reminderLeadMinutes: 30,
        },
      });

      await OrganizationSvc.leave(firm.organizationId, leaverId);
      const portfolio = (await personalOf(leaverId))!;
      const copyId = await CaseCopySvc.copy({
        sourceCaseId: source.id,
        userId: leaverId,
        targetOrganizationId: portfolio.id,
        sourceOrganizationName: "Eli Firm",
      });

      const copy = await prisma.case.findUniqueOrThrow({
        where: { id: copyId },
        include: {
          parties: true,
          timelineEvents: true,
          events: true,
          documents: { include: { file: true } },
          consultations: { include: { messages: true } },
        },
      });
      expect(copy.organizationId).to.equal(portfolio.id);
      expect(copy.userId).to.equal(leaverId);
      expect(copy.createdByName).to.equal("Lou");
      expect(copy.notes).to.equal("Some notes");
      expect(copy.copiedFromCaseId).to.equal(source.id);
      expect(copy.copiedFromOrgName).to.equal("Eli Firm");
      expect(copy.parties.map((p) => p.name)).to.deep.equal(["Acme"]);

      const [copiedDoc] = copy.documents;
      expect(copiedDoc.id).to.not.equal(doc.id);
      expect(copiedDoc.ragStatus).to.equal("PENDING");
      expect(copiedDoc.organizationId).to.equal(portfolio.id);
      expect(copiedDoc.file?.s3Key).to.match(new RegExp(`^documents/cases/${copyId}/.+\\.pdf$`));
      expect(copiedKeys).to.deep.include([file.s3Key!, copiedDoc.file!.s3Key!]);
      expect(enqueued).to.include(copiedDoc.id);

      const [timeline] = copy.timelineEvents;
      expect(timeline.documentId).to.equal(copiedDoc.id);
      expect(timeline.chunkId).to.equal(null);

      const [event] = copy.events;
      expect(event.userId).to.equal(leaverId);
      expect(event.googleEventId).to.equal(null);
      expect(event.reminderLeadMinutes).to.equal(null);

      const [copiedConsultation] = copy.consultations;
      expect(copiedConsultation.userId).to.equal(leaverId);
      expect(copiedDoc.consultationId).to.equal(copiedConsultation.id);
      const answer = copiedConsultation.messages.find((m) => m.content === "A.")!;
      const copiedQuestion = copiedConsultation.messages.find((m) => m.content === "Q?")!;
      expect(answer.parentMessageId).to.equal(copiedQuestion.id);

      // Each copied item remembers the original it came from.
      const originalParty = await prisma.party.findFirstOrThrow({ where: { caseId: source.id } });
      const originalTimeline = await prisma.caseTimelineEvent.findFirstOrThrow({ where: { caseId: source.id } });
      const originalEvent = await prisma.event.findFirstOrThrow({ where: { caseId: source.id } });
      expect(copy.parties[0].copiedFromId).to.equal(originalParty.id);
      expect(copiedDoc.copiedFromId).to.equal(doc.id);
      expect(timeline.copiedFromId).to.equal(originalTimeline.id);
      expect(event.copiedFromId).to.equal(originalEvent.id);
      expect(copiedConsultation.copiedFromId).to.equal(consultation.id);

      // The original is untouched.
      const originalDoc = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
      expect(originalDoc.organizationId).to.equal(firm.organizationId);
      expect(originalDoc.ragStatus).to.equal("READY");
    });

    it("reuses a copy made since the original last changed instead of duplicating it", async () => {
      const firm = await makeOrg("Fay Firm");
      const leaverId = await memberOf(firm.organizationId);
      const source = await CaseRepo.create(firm.organizationId, leaverId, { caseName: "Once" });
      await OrganizationSvc.leave(firm.organizationId, leaverId);
      const portfolio = (await personalOf(leaverId))!;
      const request = { sourceCaseId: source.id, userId: leaverId, targetOrganizationId: portfolio.id, sourceOrganizationName: "Fay Firm" };

      const first = await CaseCopySvc.copy(request);
      const second = await CaseCopySvc.copy(request);
      expect(second).to.equal(first);
    });
  });

  describe("a copy and its original", () => {
    it("links back once the user rejoins, flags changes, and numbers repeat copies", async () => {
      const firm = await makeOrg("Nell Firm");
      const leaverId = await memberOf(firm.organizationId);
      const source = await CaseRepo.create(firm.organizationId, leaverId, { caseName: "Twice" });
      await OrganizationSvc.leave(firm.organizationId, leaverId);
      const portfolio = (await personalOf(leaverId))!;
      const request = { sourceCaseId: source.id, userId: leaverId, targetOrganizationId: portfolio.id, sourceOrganizationName: "Nell Firm" };
      const firstCopyId = await CaseCopySvc.copy(request);

      // Away from the firm, the copy can't reach the original.
      const away = await CaseSvc.getById(firstCopyId, portfolio.id, leaverId);
      expect(away.original).to.equal(null);
      expect(away.copyVersion).to.equal(null);

      // Back in the firm, after members changed the case.
      await OrganizationInviteRepo.create(firm.organizationId, leaverId, "MEMBER");
      await OrganizationSvc.acceptInvite(firm.organizationId, leaverId);
      await prisma.case.update({ where: { id: source.id }, data: { notes: "Edited by the team" } });

      const back = await CaseSvc.getById(firstCopyId, portfolio.id, leaverId);
      expect(back.original).to.deep.equal({ id: source.id, organizationName: "Nell Firm", changedSinceCopy: true });

      // Leaving again makes a second copy rather than touching the first.
      await OrganizationSvc.leave(firm.organizationId, leaverId);
      const secondCopyId = await CaseCopySvc.copy(request);
      expect(secondCopyId).to.not.equal(firstCopyId);

      const listed = await CaseSvc.list(portfolio.id, leaverId, 1, 50);
      const versions = Object.fromEntries(listed.data.map((c) => [c.id, c.copyVersion]));
      expect(versions[firstCopyId]).to.deep.equal({ number: 1, total: 2 });
      expect(versions[secondCopyId]).to.deep.equal({ number: 2, total: 2 });
    });
  });

  describe("the rest of a removed member's work comes with them", () => {
    it("moves their own calendar, copies their appointments on others' cases, and queues their standalone consultations", async () => {
      const firm = await makeOrg("Opal Firm");
      const removedId = await memberOf(firm.organizationId, "Rae");
      const theirCase = await CaseRepo.create(firm.organizationId, removedId, { caseName: "Theirs" });
      const ownersCase = await CaseRepo.create(firm.organizationId, firm.ownerId, { caseName: "Owner's" });
      const event = (data: { title: string; caseId?: string; googleEventId?: string }) =>
        prisma.event.create({
          data: { userId: removedId, organizationId: firm.organizationId, dateTime: new Date(), reminderLeadMinutes: 15, ...data },
        });
      const googleEventId = `g-${crypto.randomUUID()}`;
      const ownAppointment = await event({ title: "Own", googleEventId });
      const onTheirCase = await event({ title: "On theirs", caseId: theirCase.id });
      const onOwnersCase = await event({ title: "On owner's", caseId: ownersCase.id });
      const note = await prisma.note.create({
        data: { userId: removedId, organizationId: firm.organizationId, date: new Date(), body: "Call client" },
      });
      const consultation = (data: { title: string; userId?: string; caseId?: string; status?: "ARCHIVED" | "FOR_DELETION" }) =>
        prisma.consultation.create({ data: { userId: removedId, organizationId: firm.organizationId, ...data } });
      const standalone = await consultation({ title: "Standalone" });
      const archived = await consultation({ title: "Archived", status: "ARCHIVED" });
      await consultation({ title: "Doomed", status: "FOR_DELETION" });
      await consultation({ title: "On owner's case", caseId: ownersCase.id });
      await consultation({ title: "Owner's chat", userId: firm.ownerId });

      await OrganizationSvc.removeMember(firm.organizationId, "OWNER", firm.ownerId, removedId);
      const portfolio = (await personalOf(removedId))!;

      // Their own appointment and note move as they are, Google link and reminder included.
      const moved = await prisma.event.findUniqueOrThrow({ where: { id: ownAppointment.id } });
      expect(moved.organizationId).to.equal(portfolio.id);
      expect(moved.googleEventId).to.equal(googleEventId);
      expect(moved.reminderLeadMinutes).to.equal(15);
      expect((await prisma.note.findUniqueOrThrow({ where: { id: note.id } })).organizationId).to.equal(portfolio.id);

      // Appointments on cases stay with the organization's cases.
      expect((await prisma.event.findUniqueOrThrow({ where: { id: onTheirCase.id } })).organizationId).to.equal(firm.organizationId);
      expect((await prisma.event.findUniqueOrThrow({ where: { id: onOwnersCase.id } })).organizationId).to.equal(firm.organizationId);
      // On someone else's case they get an unlinked copy; on their own, the case's copy brings it.
      const copies = await prisma.event.findMany({ where: { organizationId: portfolio.id, copiedFromId: { not: null } } });
      expect(copies.map((e) => e.copiedFromId)).to.deep.equal([onOwnersCase.id]);
      expect(copies[0]).to.include({ caseId: null, googleEventId: null, reminderLeadMinutes: null, title: "On owner's" });

      // Their standalone consultations (archived too) are queued for copies; the rest stay behind.
      const queued = await prisma.consultationCopy.findMany({ where: { userId: removedId } });
      expect(queued.map((q) => q.sourceConsultationId).sort()).to.deep.equal([standalone.id, archived.id].sort());
      expect(queued.every((q) => q.targetOrganizationId === portfolio.id)).to.equal(true);
    });

    it("shows them their consultations and calendar in the workspace they log back into, once copies finish", async () => {
      const firm = await makeOrg("Pia Firm");
      const removedId = await memberOf(firm.organizationId);
      const chat = await prisma.consultation.create({
        data: { userId: removedId, organizationId: firm.organizationId, title: "Advice" },
      });
      await prisma.message.create({ data: { consultationId: chat.id, role: "user", content: "Help?" } });
      await prisma.event.create({
        data: { userId: removedId, organizationId: firm.organizationId, title: "Meeting", dateTime: new Date() },
      });

      await OrganizationSvc.removeMember(firm.organizationId, "OWNER", firm.ownerId, removedId);
      await CaseCopyQueue.tick();

      // The workspace logging back in lands them in.
      const workspaceId = (await OrganizationMemberRepo.findAnyForUser(removedId))!.organizationId;
      expect(workspaceId).to.equal((await personalOf(removedId))!.id);
      const consultations = await ChatRepo.listConsultations(workspaceId);
      expect(consultations.map((c) => c.title)).to.deep.equal(["Advice"]);
      expect(consultations[0].messageCount).to.equal(1);
      const events = await prisma.event.findMany({ where: { organizationId: workspaceId, userId: removedId } });
      expect(events.map((e) => e.title)).to.deep.equal(["Meeting"]);
      // The organization keeps its original.
      expect((await ChatRepo.listConsultations(firm.organizationId)).map((c) => c.id)).to.include(chat.id);
    });

    it("doesn't copy an unchanged appointment twice when they leave, rejoin and leave again", async () => {
      const firm = await makeOrg("Quinn Firm");
      const leaverId = await memberOf(firm.organizationId);
      const ownersCase = await CaseRepo.create(firm.organizationId, firm.ownerId, { caseName: "Owner's" });
      await prisma.event.create({
        data: { userId: leaverId, organizationId: firm.organizationId, caseId: ownersCase.id, title: "Hearing", dateTime: new Date() },
      });

      await OrganizationSvc.leave(firm.organizationId, leaverId);
      await OrganizationInviteRepo.create(firm.organizationId, leaverId, "MEMBER");
      await OrganizationSvc.acceptInvite(firm.organizationId, leaverId);
      await OrganizationSvc.leave(firm.organizationId, leaverId);

      const portfolio = (await personalOf(leaverId))!;
      expect(await prisma.event.count({ where: { organizationId: portfolio.id, title: "Hearing" } })).to.equal(1);
    });
  });

  describe("CaseCopySvc.copyConsultation", () => {
    it("copies a standalone consultation with its messages and attachments, and reuses an unchanged copy", async () => {
      const firm = await makeOrg("Rex Firm");
      const leaverId = await memberOf(firm.organizationId);
      const source = await prisma.consultation.create({
        data: { userId: leaverId, organizationId: firm.organizationId, title: "Lease" },
      });
      const question = await prisma.message.create({ data: { consultationId: source.id, role: "user", content: "Q?" } });
      await prisma.message.create({
        data: { consultationId: source.id, role: "assistant", content: "A.", parentMessageId: question.id },
      });
      const file = await prisma.file.create({
        data: { filename: "lease.pdf", s3Key: `documents/consultations/${source.id}/1-ab.pdf` },
      });
      const doc = await prisma.document.create({
        data: {
          userId: leaverId,
          organizationId: firm.organizationId,
          consultationId: source.id,
          messageId: question.id,
          name: "lease.pdf",
          fileId: file.id,
        },
      });

      await OrganizationSvc.leave(firm.organizationId, leaverId);
      const portfolio = (await personalOf(leaverId))!;
      const request = { sourceConsultationId: source.id, userId: leaverId, targetOrganizationId: portfolio.id };
      const copyId = await CaseCopySvc.copyConsultation(request);

      const copy = await prisma.consultation.findUniqueOrThrow({
        where: { id: copyId },
        include: { messages: true, documents: { include: { file: true } } },
      });
      expect(copy).to.include({ organizationId: portfolio.id, userId: leaverId, caseId: null, title: "Lease", copiedFromId: source.id });
      const copiedQuestion = copy.messages.find((m) => m.content === "Q?")!;
      expect(copy.messages.find((m) => m.content === "A.")!.parentMessageId).to.equal(copiedQuestion.id);
      const [copiedDoc] = copy.documents;
      expect(copiedDoc).to.include({ copiedFromId: doc.id, organizationId: portfolio.id, caseId: null, messageId: copiedQuestion.id });
      expect(copiedDoc.file?.s3Key).to.match(new RegExp(`^documents/consultations/${copyId}/.+\\.pdf$`));
      expect(copiedKeys).to.deep.include([file.s3Key!, copiedDoc.file!.s3Key!]);
      expect(enqueued).to.include(copiedDoc.id);

      expect(await CaseCopySvc.copyConsultation(request)).to.equal(copyId);
    });
  });

  describe("CaseCopyQueue", () => {
    it("works through queued copies, and gives up on one whose original was deleted", async () => {
      const firm = await makeOrg("Gil Firm");
      const leaverId = await memberOf(firm.organizationId);
      const kept = await CaseRepo.create(firm.organizationId, leaverId, { caseName: "Kept" });
      const doomed = await CaseRepo.create(firm.organizationId, leaverId, { caseName: "Doomed" });
      await OrganizationSvc.leave(firm.organizationId, leaverId);
      await prisma.case.delete({ where: { id: doomed.id } });

      await CaseCopyQueue.tick();

      const keptCopy = await prisma.caseCopy.findFirstOrThrow({ where: { sourceCaseId: kept.id } });
      expect(keptCopy.status).to.equal("DONE");
      expect(keptCopy.copyCaseId).to.be.a("string");
      const doomedCopy = await prisma.caseCopy.findFirstOrThrow({ where: { sourceCaseId: doomed.id } });
      expect(doomedCopy.status).to.equal("FAILED");
    });
  });

  describe("portfolio access", () => {
    it("is open to its owner from another organization, and to nobody else", async () => {
      const firm = await makeOrg("Hal Firm");
      const leaverId = await memberOf(firm.organizationId);
      const source = await CaseRepo.create(firm.organizationId, leaverId, { caseName: "Travels" });
      await OrganizationSvc.leave(firm.organizationId, leaverId);
      await CaseCopyQueue.tick();
      const portfolio = (await personalOf(leaverId))!;

      // Joins another organization; the portfolio goes membership-less but stays theirs.
      const next = await makeOrg("Ida Firm");
      await OrganizationInviteRepo.create(next.organizationId, leaverId, "MEMBER");
      await OrganizationSvc.acceptInvite(next.organizationId, leaverId);

      const access = await OrganizationSvc.requireMembership(portfolio.id, leaverId);
      expect(access.role).to.equal("OWNER");
      const copy = await prisma.case.findFirstOrThrow({ where: { copiedFromCaseId: source.id } });
      expect((await CaseAccess.loadAccessibleCase(copy.id, leaverId)).id).to.equal(copy.id);

      const err = await OrganizationSvc.requireMembership(portfolio.id, next.ownerId).catch((e) => e);
      expect(err.statusCode).to.equal(403);
      const caseErr = await CaseAccess.loadAccessibleCase(copy.id, next.ownerId).catch((e) => e);
      expect(caseErr.statusCode).to.equal(404);

      const fetched = await OrganizationSvc.getPortfolio(leaverId);
      expect(fetched.id).to.equal(portfolio.id);
      expect(fetched.role).to.equal("OWNER");
    });

    it("creating an organization from a personal workspace leaves the workspace as the portfolio", async () => {
      const userId = await makeUser("Jo");
      const personal = await OrganizationSvc.create(userId, "Jo", undefined, "PH", true);
      const solo = await CaseRepo.create(personal.id, userId, { caseName: "Solo" });

      const org = await OrganizationSvc.create(userId, "Jo Law", "PROFESSIONAL", "PH");

      expect(org.id).to.not.equal(personal.id);
      expect((await OrganizationMemberRepo.findAnyForUser(userId))?.organizationId).to.equal(org.id);
      expect((await prisma.case.findUniqueOrThrow({ where: { id: solo.id } })).organizationId).to.equal(personal.id);
      expect((await CaseAccess.loadAccessibleCase(solo.id, userId)).id).to.equal(solo.id);
      expect((await OrganizationSvc.getPortfolio(userId)).id).to.equal(personal.id);
    });
  });

  describe("creator attribution", () => {
    it("keeps the organization's case, and the creator's name, when the creator's account is deleted", async () => {
      const firm = await makeOrg("Kim Firm");
      const creatorId = await memberOf(firm.organizationId, "Kai");
      const created = await CaseRepo.create(firm.organizationId, creatorId, { caseName: "Survives" });
      await prisma.organizationMember.delete({ where: { userId: creatorId } });
      await prisma.user.delete({ where: { id: creatorId } });

      const after = await CaseRepo.findById(created.id, firm.organizationId);
      expect(after?.userId).to.equal(null);
      expect(after?.createdByName).to.equal("Kai");
      expect(after?.createdBy).to.equal(null);
    });

    it("filters the list by creator", async () => {
      const firm = await makeOrg("Lux Firm");
      const memberId = await memberOf(firm.organizationId, "Mia");
      await CaseRepo.create(firm.organizationId, memberId, { caseName: "Hers" });
      await CaseRepo.create(firm.organizationId, firm.ownerId, { caseName: "Owner's" });

      const mine = await CaseRepo.list(firm.organizationId, memberId, 1, 50, undefined, "ACTIVE", memberId);
      expect(mine.data.map((c) => c.caseName)).to.deep.equal(["Hers"]);
      expect(mine.data[0].createdBy).to.include({ id: memberId, name: "Mia", isMember: true });
    });
  });
});
