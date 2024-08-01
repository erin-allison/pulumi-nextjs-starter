import Copyright from "@repo/ui/Copyright";
import ProTip from "@repo/ui/ProTip";

import picsum from "./picsum.jpg";

import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import Image from "next/image";
import NextLink from "next/link";

export default function Home() {
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
          Documentation Website for Starter
        </Typography>
        <Image src={picsum} alt={"asdf"}></Image>
        <Link href="/about" color="secondary" component={NextLink}>
          Go to the about page
        </Link>
        <Link href="/../" color="secondary" component={NextLink}>
          Go to the main app
        </Link>
        <ProTip />
        <Copyright />
      </Box>
    </Container>
  );
}
