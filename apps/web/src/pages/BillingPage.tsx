import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, Notice, Progress, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatUsage as formatUsed } from '@/lib/utils';

export function BillingPage() {
  const usage = useQuery({ queryKey: qk.usage, queryFn: api.usage });
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Usage & plan</h1>
        <p className="text-sm text-muted-foreground">Limits reset at the start of each month. Storage counts what you keep right now.</p>
      </div>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>Demo plan</CardTitle>
            <Badge variant="success">Free</Badge>
          </div>
          <CardDescription>Payments are not enabled. Nothing is ever charged; when a limit is reached the action is paused until next month.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {usage.isPending ? (
            <Skeleton className="h-40" />
          ) : usage.isError ? (
            <Notice tone="error">{errorMessage(usage.error)}</Notice>
          ) : (
            <>
              {usage.data.items.map((item) => (
                <div key={item.kind} className="space-y-1.5">
                  <div className="flex justify-between text-sm">
                    <span className="capitalize">{item.kind.replace(/_/gu, ' ')}</span>
                    <span className="text-muted-foreground">
                      {formatUsed(item.used, item.unit)} of {formatUsed(item.limit, item.unit)}
                    </span>
                  </div>
                  <Progress label={`${item.kind} usage`} value={item.limit > 0 ? item.used / item.limit : 0} />
                </div>
              ))}
              <p className="text-xs text-muted-foreground">{usage.data.note}</p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
