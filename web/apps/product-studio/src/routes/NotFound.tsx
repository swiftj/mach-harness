import { Link } from "react-router";
import { MapPinOff } from "lucide-react";
import { Button, EmptyState, Page } from "@mach/ui";

export function NotFound() {
  return (
    <Page>
      <EmptyState
        layout="page"
        headingLevel={1}
        icon={<MapPinOff />}
        title="Nothing here"
        description="This address does not match a page in Product Studio."
        action={
          <Button asChild>
            <Link to="/">Go to Home</Link>
          </Button>
        }
      />
    </Page>
  );
}
