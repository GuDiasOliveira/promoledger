"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";

import { type AdminScope, WithAdmin } from "@/components/admin/admin-scope";
import { Badge, Button, Card, ErrorBanner, Field } from "@/components/ui";
import { api, type Schemas, unwrap } from "@/lib/api/client";
import { useLastError } from "@/lib/admin/last-error";
import { useErrorMessage } from "@/lib/hooks";

const ROLES = ["seller", "promotion_admin", "promotion_viewer"] as const;
type Role = (typeof ROLES)[number];
type Member = Schemas["MemberResponse"];

function RolePicker({ value, onChange }: { value: Role[]; onChange: (roles: Role[]) => void }) {
  const t = useTranslations();
  return (
    <fieldset className="flex flex-wrap gap-3">
      <legend className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">{t("members.roles")}</legend>
      {ROLES.map((role) => (
        <label key={role} className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={value.includes(role)}
            onChange={(e) => onChange(e.target.checked ? [...value, role] : value.filter((r) => r !== role))}
          />
          {t(`promotions.roles.${role}`)}
        </label>
      ))}
    </fieldset>
  );
}

function MemberRow({
  member,
  isMe,
  onUpdate,
  pending,
}: {
  member: Member;
  isMe: boolean;
  onUpdate: (body: Schemas["MemberUpdate"]) => void;
  pending: boolean;
}) {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [roles, setRoles] = useState<Role[]>(member.roles as Role[]);
  const revoked = member.revoked_at !== null && member.revoked_at !== undefined;

  return (
    <li className="space-y-2 py-3" data-testid="member-row">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-medium">{member.user.name}</span>
          {isMe ? <span className="text-sm text-zinc-500"> ({t("members.you")})</span> : null}
          <p className="text-sm text-zinc-500">{member.user.email}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {revoked ? <Badge tone="amber">{t("members.revoked")}</Badge> : null}
          {member.roles.map((role) => (
            <Badge key={role}>{t(`promotions.roles.${role as Role}`)}</Badge>
          ))}
        </div>
      </div>
      {editing ? (
        <div className="space-y-2">
          <RolePicker value={roles} onChange={setRoles} />
          <div className="flex gap-2">
            <Button
              disabled={roles.length === 0 || pending}
              onClick={() => {
                onUpdate({ roles });
                setEditing(false);
              }}
            >
              {t("form.save")}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              {t("form.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          {!revoked ? (
            <Button variant="ghost" onClick={() => setEditing(true)}>
              {t("members.editRoles")}
            </Button>
          ) : null}
          <Button variant="ghost" disabled={pending} onClick={() => onUpdate({ revoked: !revoked })}>
            {revoked ? t("members.reinstate") : t("members.revoke")}
          </Button>
        </div>
      )}
    </li>
  );
}

function Members({ promotion }: AdminScope) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [email, setEmail] = useState("");
  const [roles, setRoles] = useState<Role[]>(["seller"]);
  const key = ["admin", promotion.id, "members", includeRevoked];
  const members = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/promotions/{promotion_id}/members", {
          params: { path: { promotion_id: promotion.id }, query: { include_revoked: includeRevoked, page: 1, size: 100 } },
        }),
      ),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["admin", promotion.id] });
  const last = useLastError();

  const add = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/promotions/{promotion_id}/members", {
          params: { path: { promotion_id: promotion.id } },
          body: { email: email.trim(), roles },
        }),
      ),
    ...last.handlers,
    onSuccess: () => {
      setEmail("");
      setRoles(["seller"]);
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Schemas["MemberUpdate"] }) =>
      unwrap(
        api.PATCH("/api/v1/promotions/{promotion_id}/members/{member_id}", {
          params: { path: { promotion_id: promotion.id, member_id: id } },
          body,
        }),
      ),
    ...last.handlers,
    onSuccess: refresh,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (email.trim() && roles.length > 0) add.mutate();
  };
  const error = last.error ?? members.error;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t("members.title")}</h1>
      <Card>
        <form onSubmit={submit} className="space-y-3" aria-label={t("members.add")}>
          <h2 className="font-semibold">{t("members.add")}</h2>
          <Field label={t("members.email")} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <RolePicker value={roles} onChange={setRoles} />
          {roles.length === 0 ? <p className="text-sm text-red-700">{t("members.pickRole")}</p> : null}
          <Button type="submit" disabled={!email.trim() || roles.length === 0 || add.isPending}>
            {t("members.add")}
          </Button>
          {add.isSuccess ? (
            <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
              ✓ {t("members.added")}
            </p>
          ) : null}
        </form>
      </Card>
      <ErrorBanner message={error ? errorMessage(error) : null} />
      <Card>
        <label className="mb-2 flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" className="h-5 w-5" checked={includeRevoked} onChange={(e) => setIncludeRevoked(e.target.checked)} />
          {t("members.includeRevoked")}
        </label>
        {!members.data ? (
          <p>{t("common.loading")}</p>
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {members.data.items.map((m) => (
              <MemberRow
                key={`${m.id}:${m.roles.join(",")}:${m.revoked_at ?? ""}`}
                member={m}
                isMe={m.id === promotion.memberId}
                pending={update.isPending}
                onUpdate={(body) => update.mutate({ id: m.id, body })}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function MembersPage() {
  return <WithAdmin adminOnly>{(scope) => <Members {...scope} />}</WithAdmin>;
}
