import Copyright from "@repo/ui/Copyright";
import ProTip from "@repo/ui/ProTip";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Typography from "@mui/material/Typography";
import NextLink from "next/link";

export default function About() {
  return (
    <Container maxWidth="lg">
      <Box
        sx={{
          my: 4,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Typography variant="h4" component="h1" sx={{ mb: 2 }}>
          Material UI - Next.js example in TypeScript
        </Typography>
        <Box sx={{ maxWidth: "sm" }}>
          <Button variant="contained" component={NextLink} href="/">
            Go to the home page
          </Button>
        </Box>
        <ProTip />
        <Copyright />
      </Box>
    </Container>
  );
}
