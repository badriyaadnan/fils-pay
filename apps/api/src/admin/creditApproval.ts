import { ConflictError } from "../lib/errors.js";

/** An operator on one side of a credit's two-person control. */
export interface CreditActor {
  adminUserId: string;
  displayName: string;
}

/** Two-person control: the operator who approves a credit must not be the one who requested it. */
export function assertDistinctApprover(requester: CreditActor, approver: CreditActor): void {
  // Fix 1.7: compare the user ID, not the display name. Names are not unique
  // and can be changed, so an operator could rename themselves and approve
  // their own credit. The ID never changes and is unique per person.
  // إصلاح 1.7: نقارن رقم المستخدم مو الاسم. الأسماء ممكن تتكرر وممكن
  // تتغير، فالموظف يقدر يغيّر اسمه ويوافق على طلبه هو. الرقم ما يتغير
  // وما يتكرر.
  if (approver.adminUserId === requester.adminUserId) {
    throw new ConflictError("self_approval_forbidden");
  }
}